"""
Heuristic priority-based dispatcher for Flatland ECML 2026.

Design:
  - The competition runs on a single fixed topology, so we lean hard on
    classical planning. The dispatcher provides a "follow the geodesic
    unless someone with higher priority needs the cell" policy.
  - Per step we:
      1. Advance per-agent waypoint index if they reached their next stop.
      2. Compute slack-based priority: low slack -> high priority.
      3. Project each active agent forward along its shortest path and
         reserve (cell, time) for them in priority order.
      4. Each agent's chosen action follows the geodesic if its next cell
         is free, otherwise STOP_MOVING. Head-on encounters get the same
         treatment - lower-priority side yields.

Self-contained: no torch, no learning, no env mutation. A learned policy
will later read the dispatcher's recommendation as an action prior.
"""

from __future__ import annotations

from collections import deque
from typing import Dict, List, Tuple

import numpy as np
from flatland.core.grid.grid4_utils import get_new_position
from flatland.envs.fast_methods import fast_count_nonzero
from flatland.envs.step_utils.states import TrainState


# RailEnvActions
DO_NOTHING = 0
MOVE_LEFT = 1
MOVE_FORWARD = 2
MOVE_RIGHT = 3
STOP_MOVING = 4

INF = np.iinfo(np.int32).max


class HeuristicDispatcher:
    """Priority + reservation dispatcher. Distance maps are cached by
    target cell, which is shared across agents heading to the same
    station - cheap on a fixed topology."""

    # Forward reservation horizon. 12 covers typical single-track
    # corridors on the competition map.
    RESERVE_HORIZON = 12

    # Hard cap on corridor scan length (cells). Single-track corridors on
    # the competition map can be quite long; we still cap to bound cost.
    CORRIDOR_SCAN_MAX = 200

    def __init__(self):
        self.env = None
        # handle -> index of last waypoint visited (0 = not yet departed)
        self.waypoint_index: Dict[int, int] = {}
        # target_position -> dist[H, W, 4] int32 BFS distance map
        self._dist_cache: Dict[Tuple[int, int], np.ndarray] = {}
        # switch cells (any incoming direction has >1 outgoing)
        self._switches: set = set()
        # plan cached per env step
        self._step_seen: int = -1
        self._plan: Dict[int, int] = {}
        # (cell, t) -> handle holding that reservation
        self._reservations: Dict[Tuple[Tuple[int, int], int], int] = {}
        # priority rank per handle (lower = higher priority)
        self._rank: Dict[int, int] = {}

    # ------------------------------------------------------------------
    # Setup
    # ------------------------------------------------------------------

    def set_env(self, env):
        self.env = env

    def reset(self):
        self.waypoint_index = {}
        self._dist_cache = {}
        self._switches = set()
        self._step_seen = -1
        self._plan = {}
        self._reservations = {}
        self._rank = {}
        if self.env is None or self.env.rail is None:
            return
        self._build_switches()
        for h in self.env.get_agent_handles():
            self.waypoint_index[h] = 0

    def _build_switches(self):
        switches = set()
        H, W = self.env.height, self.env.width
        for r in range(H):
            for c in range(W):
                pos = (r, c)
                for d in range(4):
                    t = self.env.rail.get_transitions((pos, d))
                    if fast_count_nonzero(t) > 1:
                        switches.add(pos)
                        break
        self._switches = switches

    # ------------------------------------------------------------------
    # Distance maps (backward BFS from target on the directed rail graph)
    # ------------------------------------------------------------------

    def _dist_map(self, target_pos: Tuple[int, int]) -> np.ndarray:
        cached = self._dist_cache.get(target_pos)
        if cached is not None:
            return cached
        rail = self.env.rail
        H, W = self.env.height, self.env.width
        dist = np.full((H, W, 4), INF, dtype=np.int32)
        q: deque = deque()
        for d in range(4):
            if rail.get_transitions((target_pos, d)) != (0, 0, 0, 0):
                dist[target_pos[0], target_pos[1], d] = 0
                q.append((target_pos, d, 0))
        while q:
            pos, direction, cd = q.popleft()
            prev_pos = get_new_position(pos, (direction + 2) % 4)
            if not (0 <= prev_pos[0] < H and 0 <= prev_pos[1] < W):
                continue
            for ad in range(4):
                if rail.get_transition((prev_pos, ad), direction):
                    nd = cd + 1
                    if nd < dist[prev_pos[0], prev_pos[1], ad]:
                        dist[prev_pos[0], prev_pos[1], ad] = nd
                        q.append((prev_pos, ad, nd))
        self._dist_cache[target_pos] = dist
        return dist

    # ------------------------------------------------------------------
    # Waypoints
    # ------------------------------------------------------------------

    def _next_target(self, handle: int) -> Tuple[int, int]:
        agent = self.env.agents[handle]
        wps = agent.waypoints
        idx = self.waypoint_index.get(handle, 0) + 1
        if idx < len(wps):
            return wps[idx][0].position
        return agent.target

    def _advance_waypoint(self, handle: int):
        agent = self.env.agents[handle]
        wps = agent.waypoints
        idx = self.waypoint_index.get(handle, 0) + 1
        if idx >= len(wps):
            return
        if agent.position is None:
            return
        for wp in wps[idx]:
            if wp.position == agent.position:
                self.waypoint_index[handle] = idx
                break

    def _latest_arrival(self, handle: int) -> int:
        agent = self.env.agents[handle]
        idx = self.waypoint_index.get(handle, 0) + 1
        la_list = getattr(agent, "waypoints_latest_arrival", None)
        if la_list is not None and idx < len(la_list) and la_list[idx] is not None:
            return int(la_list[idx])
        if agent.latest_arrival is not None:
            return int(agent.latest_arrival)
        return int(self.env._max_episode_steps)

    # ------------------------------------------------------------------
    # Agent state helpers
    # ------------------------------------------------------------------

    def _virtual_pos_dir(self, agent):
        """Return (pos, direction) treating off-map states as if at the
        initial cell. (None, None) once DONE."""
        if agent.state in (
            TrainState.READY_TO_DEPART,
            TrainState.WAITING,
            TrainState.MALFUNCTION_OFF_MAP,
        ):
            return agent.initial_position, agent.initial_direction
        if agent.state in (
            TrainState.MOVING,
            TrainState.STOPPED,
            TrainState.MALFUNCTION,
        ):
            d = agent.direction if agent.direction is not None else agent.initial_direction
            return agent.position, d
        return None, None

    def _malfunction_steps(self, agent) -> int:
        mh = getattr(agent, "malfunction_handler", None)
        if mh is None:
            return 0
        return int(getattr(mh, "malfunction_down_counter", 0))

    # ------------------------------------------------------------------
    # Geodesic step + projection
    # ------------------------------------------------------------------

    def _best_direction(self, pos, direction, target):
        rail = self.env.rail
        dm = self._dist_map(target)
        possible = rail.get_transitions((pos, direction))
        best_dir = None
        best_d = INF
        for nd in range(4):
            if possible[nd] == 1:
                npos = get_new_position(pos, nd)
                if not (0 <= npos[0] < self.env.height and 0 <= npos[1] < self.env.width):
                    continue
                d_val = int(dm[npos[0], npos[1], nd])
                if d_val < best_d:
                    best_d = d_val
                    best_dir = nd
        if best_dir is None:
            return None, None
        if best_dir == direction:
            act = MOVE_FORWARD
        elif best_dir == (direction - 1) % 4:
            act = MOVE_LEFT
        elif best_dir == (direction + 1) % 4:
            act = MOVE_RIGHT
        else:
            act = MOVE_FORWARD  # reverse - no direct action, fall back
        return best_dir, act

    def _alternative_direction(self, pos, direction, target, exclude_dir):
        rail = self.env.rail
        dm = self._dist_map(target)
        possible = rail.get_transitions((pos, direction))
        best_dir = None
        best_d = INF
        for nd in range(4):
            if nd == exclude_dir or possible[nd] != 1:
                continue
            npos = get_new_position(pos, nd)
            if not (0 <= npos[0] < self.env.height and 0 <= npos[1] < self.env.width):
                continue
            d_val = int(dm[npos[0], npos[1], nd])
            if d_val < best_d:
                best_d = d_val
                best_dir = nd
        if best_dir is None or best_d >= INF // 2:
            return None
        if best_dir == direction:
            act = MOVE_FORWARD
        elif best_dir == (direction - 1) % 4:
            act = MOVE_LEFT
        elif best_dir == (direction + 1) % 4:
            act = MOVE_RIGHT
        else:
            act = MOVE_FORWARD
        return best_dir, act

    def _project_path(self, handle: int, max_steps: int):
        """Returns list of (cell, t, direction) the agent is expected to
        occupy. Direction is the heading into that cell (-1 for the
        starting cell while stationary)."""
        agent = self.env.agents[handle]
        pos, direction = self._virtual_pos_dir(agent)
        if pos is None:
            return []
        wps = agent.waypoints
        wp_idx = self.waypoint_index.get(handle, 0)
        target = self._next_target(handle)
        cells = []
        t = int(self.env._elapsed_steps)
        mf = self._malfunction_steps(agent)
        for _ in range(min(mf, max_steps)):
            cells.append((pos, t, direction))
            t += 1
        while len(cells) < max_steps:
            cells.append((pos, t, direction))
            t += 1
            nxt_dir, _ = self._best_direction(pos, direction, target)
            if nxt_dir is None:
                break
            pos = get_new_position(pos, nxt_dir)
            direction = nxt_dir
            if pos == target:
                wp_idx += 1
                if wp_idx + 1 < len(wps):
                    target = wps[wp_idx + 1][0].position
                else:
                    target = agent.target
        return cells

    # ------------------------------------------------------------------
    # Per-step plan
    # ------------------------------------------------------------------

    def _ensure_step(self):
        cur = int(self.env._elapsed_steps)
        if cur == self._step_seen:
            return
        self._step_seen = cur
        self._compute_plan()

    def _priority_score(self, handle: int) -> float:
        agent = self.env.agents[handle]
        if agent.state in (TrainState.DONE,):
            return float("inf")
        pos, direction = self._virtual_pos_dir(agent)
        if pos is None:
            return float("inf")
        target = self._next_target(handle)
        dm = self._dist_map(target)
        dd = int(dm[pos[0], pos[1], direction])
        if dd >= INF // 2:
            return 1e9
        latest = self._latest_arrival(handle)
        slack = latest - int(self.env._elapsed_steps) - dd
        return float(slack)

    def _compute_plan(self):
        self._reservations = {}
        self._rank = {}

        for h in self.env.get_agent_handles():
            self._advance_waypoint(h)

        active: List[int] = []
        for h in self.env.get_agent_handles():
            agent = self.env.agents[h]
            if agent.state in (TrainState.DONE,):
                continue
            active.append(h)

        priorities = {h: self._priority_score(h) for h in active}
        order = sorted(active, key=lambda h: (priorities[h], h))
        for rank, h in enumerate(order):
            self._rank[h] = rank

        # Reserve projected paths in priority order. A path is corridor-
        # blocked iff one of its projected cells is reserved by a
        # higher-priority agent with an OPPOSING direction at the same
        # or an adjacent time step (the head-on conflict signature).
        # Same-direction overlaps (followers) are not conflicts.
        self._blocked_corridor: set = set()
        # _reservations: (cell, t) -> (handle, direction)
        self._reservations = {}
        for h in order:
            cells = self._project_path(h, self.RESERVE_HORIZON)
            conflict = False
            for cell, t, d in cells[1:]:
                for dt in (-1, 0, 1):
                    prior = self._reservations.get((cell, t + dt))
                    if prior is None:
                        continue
                    p_h, p_d = prior
                    if p_h == h:
                        continue
                    if p_d == (d + 2) % 4:  # head-on
                        conflict = True
                        break
                if conflict:
                    break
            if conflict:
                self._blocked_corridor.add(h)
            else:
                for cell, t, d in cells:
                    self._reservations.setdefault((cell, t), (h, d))

        self._plan = {}
        for h in self.env.get_agent_handles():
            self._plan[h] = self._decide_action(h) if h in priorities else DO_NOTHING

    # ------------------------------------------------------------------
    # Per-agent action
    # ------------------------------------------------------------------

    def _has_higher_priority(self, other: int, me: int) -> bool:
        ro = self._rank.get(other)
        rm = self._rank.get(me)
        if ro is None or rm is None:
            return False
        return ro < rm

    def _corridor_opposing(self, handle, pos, direction):
        """Walk the single-track corridor from (pos, direction) until a
        switch. Return the handle of the FIRST agent we find inside the
        corridor whose direction is opposite to ours - i.e. would
        deadlock if we entered. Same-direction agents and stalled agents
        are not returned (different check)."""
        rail = self.env.rail
        cur_pos, cur_dir = pos, direction
        for _ in range(self.CORRIDOR_SCAN_MAX):
            occ = self.env.agent_positions[cur_pos]
            if occ != -1 and occ != handle:
                other = self.env.agents[occ]
                if other.direction is not None and int(other.direction) == (cur_dir + 2) % 4:
                    return occ
                # Same-direction agent: not a head-on, but treated as a
                # blocker by the near-cell check below.
            if cur_pos in self._switches:
                return None
            t = rail.get_transitions((cur_pos, cur_dir))
            count = fast_count_nonzero(t)
            if count != 1:
                return None
            nd = int(np.argmax(t))
            cur_pos = get_new_position(cur_pos, nd)
            cur_dir = nd
        return None

    def _immediate_blocker(self, handle, pos, direction, depth=6):
        """Return the handle of the nearest agent in our path, scanning
        forward up to `depth` cells through a corridor. Any direction."""
        rail = self.env.rail
        cur_pos, cur_dir = pos, direction
        for _ in range(depth):
            occ = self.env.agent_positions[cur_pos]
            if occ != -1 and occ != handle:
                return occ
            if cur_pos in self._switches:
                return None
            t = rail.get_transitions((cur_pos, cur_dir))
            if fast_count_nonzero(t) != 1:
                return None
            nd = int(np.argmax(t))
            cur_pos = get_new_position(cur_pos, nd)
            cur_dir = nd
        return None

    def _decide_action(self, handle: int) -> int:
        agent = self.env.agents[handle]
        st = agent.state

        if st in (TrainState.DONE,):
            return DO_NOTHING
        if st == TrainState.WAITING:
            return DO_NOTHING
        if st == TrainState.MALFUNCTION:
            return DO_NOTHING

        if st == TrainState.READY_TO_DEPART:
            init_pos = agent.initial_position
            t_now = int(self.env._elapsed_steps)
            occ = self.env.agent_positions[init_pos]
            if occ != -1 and occ != handle:
                return DO_NOTHING
            entry = self._reservations.get((init_pos, t_now))
            if entry is not None:
                holder, _ = entry
                if holder != handle and self._has_higher_priority(holder, handle):
                    return DO_NOTHING
            return MOVE_FORWARD

        # On map: STOPPED or MOVING.
        pos, direction = self._virtual_pos_dir(agent)
        if pos is None:
            return DO_NOTHING
        target = self._next_target(handle)
        nxt_dir, geodesic_act = self._best_direction(pos, direction, target)
        if nxt_dir is None:
            return STOP_MOVING
        npos = get_new_position(pos, nxt_dir)
        t_next = int(self.env._elapsed_steps) + 1

        on_switch = pos in self._switches

        def try_alt():
            if not on_switch:
                return None
            alt = self._alternative_direction(pos, direction, target, nxt_dir)
            if alt is None:
                return None
            alt_dir, alt_act = alt
            alt_pos = get_new_position(pos, alt_dir)
            if self.env.agent_positions[alt_pos] not in (-1, handle):
                return None
            if self._corridor_opposing(handle, alt_pos, alt_dir) is not None:
                return None
            return alt_act

        # 1. Don't enter a corridor that already contains an opposing
        # train - that's an immediate physical deadlock.
        if self._corridor_opposing(handle, npos, nxt_dir) is not None:
            alt_act = try_alt()
            return alt_act if alt_act is not None else STOP_MOVING

        # 2. Don't enter a corridor that a higher-priority projection has
        # claimed (caught by the reservation pass). Same fallback.
        if handle in self._blocked_corridor:
            alt_act = try_alt()
            return alt_act if alt_act is not None else STOP_MOVING

        # 3. Immediate-cell occupancy: yield (STOP). Geodesic will be
        # reissued next step when the blocker clears.
        if self._immediate_blocker(handle, npos, nxt_dir, depth=1) is not None:
            return STOP_MOVING

        return geodesic_act

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def act(self, handle: int) -> int:
        self._ensure_step()
        return self._plan.get(handle, DO_NOTHING)

    def priority_rank(self, handle: int) -> int:
        self._ensure_step()
        return self._rank.get(handle, -1)

    def slack(self, handle: int) -> float:
        self._ensure_step()
        return float(self._priority_score(handle))
