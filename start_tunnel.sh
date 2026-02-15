#!/bin/bash
while true; do
  echo "Starting ngrok tunnel..."
  ngrok http 8000 --url https://lightly-magical-lemming.ngrok-free.app --pooling-enabled
  echo "Ngrok tunnel disconnected. Restarting in 5 seconds..."
  sleep 5
done
