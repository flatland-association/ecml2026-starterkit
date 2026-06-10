from typing import Any

from flatland.envs.RailEnvPolicy import RailEnvPolicy
from flatland.envs.rail_env_action import RailEnvActions
from flatland.utils.seeding import np_random


class RandomPolicy(RailEnvPolicy):
    """Random policy returning uniformly random actions."""

    def __init__(self, action_size: int = 5, seed=42):
        super(RandomPolicy, self).__init__()
        self.action_size = action_size
        self.np_random, _ = np_random(seed=seed)

    def act(self, observation: Any, **kwargs) -> RailEnvActions:
        return self.np_random.choice(self.action_size)
