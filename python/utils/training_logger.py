import csv
import os

class TrainingLogger:
    def __init__(self, log_dir="logs", filename="trajectory.csv"):
        self.log_dir = log_dir
        os.makedirs(self.log_dir, exist_ok=True)
        self.filepath = os.path.join(self.log_dir, filename)
        
        # Initialize the file with headers
        self.f = open(self.filepath, 'w', newline='')
        self.writer = csv.writer(self.f)
        self.writer.writerow(["episode", "tick", "playerX", "playerY", "opX", "opY", "reward", "done"])
            
    def log_step(self, episode, tick, obs, reward, done):
        """
        obs is assumed to be the 14-dim numpy array from BonkEnv.
        [0]: playerX, [1]: playerY
        [7]: opX, [8]: opY
        """
        playerX = obs[0]
        playerY = obs[1]
        opX = obs[7]
        opY = obs[8]
        
        self.writer.writerow([episode, tick, playerX, playerY, opX, opY, reward, done])
        
    def close(self):
        self.f.close()
