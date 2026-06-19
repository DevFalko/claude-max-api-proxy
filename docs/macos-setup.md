# macOS Auto-Start Setup

This guide shows how to configure Claude Max API Proxy to start automatically when you log in.

## Create LaunchAgent

1. Create the plist file:

```bash
cat > ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.openclaw.claude-max-proxy</string>
    
    <key>Comment</key>
    <string>Claude Max API Proxy (uses Claude Max subscription)</string>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>/path/to/claude-max-api-proxy/dist/server/standalone.js</string>
    </array>
    
    <key>StandardOutPath</key>
    <string>/tmp/claude-max-proxy.log</string>
    
    <key>StandardErrorPath</key>
    <string>/tmp/claude-max-proxy.err.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>/Users/YOUR_USERNAME</string>
      <key>PATH</key>
      <string>/Users/YOUR_USERNAME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
PLIST
```

2. **Important:** Edit the file and replace:
  - `/path/to/claude-max-api-proxy` with your actual path
   - `/Users/YOUR_USERNAME` with your actual username
   - Ensure the PATH includes the directory containing `claude` (check with `which claude`)

## Load the Service

```bash
# Load and start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Verify it's running
launchctl list | grep claude-max-proxy
curl http://localhost:3456/health
```

## Management Commands

```bash
# Check status
launchctl list | grep claude-max-proxy

# Restart the service
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop the service (temporary)
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy

# Start the service again
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# View logs
tail -f /tmp/claude-max-proxy.log
tail -f /tmp/claude-max-proxy.err.log
```

## Uninstall

```bash
# Stop and remove the service
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
rm ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

## Troubleshooting

### Service starts but health check fails

Check the error log:
```bash
cat /tmp/claude-max-proxy.err.log
```

Common issues:
- Wrong path to `standalone.js`
- `claude` CLI not in PATH
- Node.js not found

### Finding the right paths

```bash
# Find node
which node

# Find claude
which claude

# Your home directory
echo $HOME
```
