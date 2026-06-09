from typing import Any

from flatland.envs.RailEnvPolicy import RailEnvPolicy
from flatland.envs.rail_env_action import RailEnvActions
from flatland.utils.seeding import np_random


class RandomPolicy(RailEnvPolicy):
    """
    Random action with reset of random sequence to allow synchronization with partial trajectory.
    """

    def __init__(self, action_size: int = 5, seed=42):
        """
        Parameters
        ----------
        """
        super(RandomPolicy, self).__init__()
        self.action_size = action_size
        self._seed = seed
        self.np_random, _ = np_random(seed=self._seed)

    def act(self, observation: Any, **kwargs) -> RailEnvActions:
        return self.np_random.choice(self.action_size)
