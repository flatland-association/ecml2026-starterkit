import json
import argparse
import sys
import numpy as np

from test_dispatcher import make_env
from flatland.envs.step_utils.states import TrainState
from submission.my_policy import MyPolicy

def serialize_position(pos):
    if pos is None:
        return None
    return [int(pos[0]), int(pos[1])]

def main():
    parser = argparse.ArgumentParser(description="Run Flatland episode and export trajectory data.")
    parser.add_argument("--num-agents", type=int, default=15, help="Number of agents")
    parser.add_argument("--width", type=int, default=35, help="Map width")
    parser.add_argument("--height", type=int, default=35, help="Map height")
    parser.add_argument("--num-cities", type=int, default=3, help="Number of cities")
    parser.add_argument("--seed", type=int, default=2, help="Random seed")
    parser.add_argument("--malfunctions", action="store_true", help="Enable malfunctions")
    parser.add_argument("--output", type=str, default="visualizer/trajectory.json", help="Output JSON path")
    args = parser.parse_args()

    print(f"Creating env (agents={args.num_agents}, size={args.width}x{args.height}, seed={args.seed})...")
    env = make_env(
        num_agents=args.num_agents,
        width=args.width,
        height=args.height,
        num_cities=args.num_cities,
        seed=args.seed,
        malfunctions=args.malfunctions
    )
    policy = MyPolicy()

    # Reset environment
    obs_dict, _info = env.reset()
    dispatcher = env.obs_builder.dispatcher

    # Export grid and metadata
    grid_data = []
    for r in range(env.height):
        row = []
        for c in range(env.width):
            row.append(int(env.rail.grid[r, c]))
        grid_data.append(row)

    agents_metadata = []
    for h in env.get_agent_handles():
        agent = env.agents[h]
        wps = []
        for wp_list in agent.waypoints:
            wp_row = []
            for wp in wp_list:
                wp_row.append(serialize_position(wp.position))
            wps.append(wp_row)
        
        agents_metadata.append({
            "handle": int(h),
            "initial_position": serialize_position(agent.initial_position),
            "initial_direction": int(agent.initial_direction) if agent.initial_direction is not None else None,
            "target": serialize_position(agent.target),
            "waypoints": wps,
            "latest_arrival": int(agent.latest_arrival) if agent.latest_arrival is not None else None,
        })

    trajectory = {
        "metadata": {
            "width": int(env.width),
            "height": int(env.height),
            "num_agents": int(args.num_agents),
            "num_cities": int(args.num_cities),
            "seed": int(args.seed),
            "malfunctions": bool(args.malfunctions),
            "max_episode_steps": int(env._max_episode_steps),
        },
        "grid": grid_data,
        "agents": agents_metadata,
        "steps": [],
    }

    print("Running simulation and recording steps...")
    M = env._max_episode_steps
    
    # We record step 0 (initial state after reset)
    step_record = record_step(env, obs_dict, dispatcher, 0, {}, {h: False for h in env.get_agent_handles()})
    trajectory["steps"].append(step_record)

    for step in range(1, M + 1):
        handles = env.get_agent_handles()
        observations = [obs_dict[h] for h in handles]
        
        # Step action selection
        action_dict = policy.act_many(handles, observations)
        
        # Environment step
        obs_dict, rewards, dones, _info = env.step(action_dict)
        
        # Record step state
        step_record = record_step(env, obs_dict, dispatcher, step, action_dict, dones)
        trajectory["steps"].append(step_record)

        if dones["__all__"]:
            print(f"Episode completed at step {step}")
            break

    # Save to file
    import os
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(trajectory, f, indent=2)
    print(f"Trajectory saved to {args.output}")

def record_step(env, obs_dict, dispatcher, step_idx, action_dict, dones):
    agents_states = []
    for h in env.get_agent_handles():
        agent = env.agents[h]
        obs = obs_dict.get(h)
        
        # Get action mask and recommended action from observation if available
        action_mask = [1.0, 0.0, 0.0, 0.0, 0.0]
        rec_action = 0
        if obs is not None and len(obs) >= 10:
            rec_action = int(np.argmax(obs[:5]))
            action_mask = [float(x) for x in obs[5:10]]

        # Malfunction countdown
        mh = getattr(agent, "malfunction_handler", None)
        mf = int(getattr(mh, "malfunction_down_counter", 0)) if mh is not None else 0

        # State name
        state_name = agent.state.name if hasattr(agent.state, "name") else str(agent.state)

        agents_states.append({
            "handle": int(h),
            "position": serialize_position(agent.position),
            "direction": int(agent.direction) if agent.direction is not None else None,
            "state": state_name,
            "action": int(action_dict.get(h, 0)),
            "recommended_action": rec_action,
            "action_mask": action_mask,
            "slack": float(dispatcher.slack(h)),
            "priority_rank": int(dispatcher.priority_rank(h)),
            "malfunction": mf,
        })

    # Record reservations
    reservations = []
    for (cell, res_t), holder in dispatcher._reservations.items():
        holder_handle, holder_dir = holder
        reservations.append({
            "r": int(cell[0]),
            "c": int(cell[1]),
            "t": int(res_t),
            "handle": int(holder_handle),
            "direction": int(holder_dir) if holder_dir is not None else None
        })

    return {
        "step": int(step_idx),
        "agents": agents_states,
        "reservations": reservations,
        "done": bool(dones.get("__all__", False))
    }

if __name__ == "__main__":
    main()
