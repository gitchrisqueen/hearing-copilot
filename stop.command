#!/bin/bash
# Stop every Hearing Copilot service, including strays left by a previous run.
# Double-click to run. Kills whatever is listening on the app's five ports.
#   8777 web app | 8790 log/settings | 8791 voice profiles | 8089 whisper | 11500 ollama
echo "Stopping Hearing Copilot services..."
for PORT in 8777 8790 8791 8089 11500; do
  PIDS=$(lsof -ti ":$PORT" 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "  port $PORT -> killing $PIDS"
    kill $PIDS 2>/dev/null
    sleep 1
    STILL=$(lsof -ti ":$PORT" 2>/dev/null)
    [ -n "$STILL" ] && { echo "  port $PORT -> force killing $STILL"; kill -9 $STILL 2>/dev/null; }
  else
    echo "  port $PORT -> nothing running"
  fi
done
echo "Done. You can relaunch with launch.command."
