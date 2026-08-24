# The engine now lives in copilot-core (shared with tech-interview-copilot). This shim keeps
# replay.py's imports working without every caller needing to know that.
from copilot_core.speaker.engine import Profile, SpeakerEngine  # noqa: F401
