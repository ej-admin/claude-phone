# Outbound Calling API

API reference for initiating outbound calls from Claude Phone.

## Overview

The outbound calling API allows your server to call phone numbers and deliver messages. Use cases:

- Server alerts ("Your disk is 95% full")
- Automated notifications
- Two-way conversations triggered by events

## Authentication and allowed destinations

Every route on this API except `GET /health` requires the `X-Claude-Api-Key` header to equal the
voice-app's `CLAUDE_API_KEY` (the same shared secret the Claude API server uses). Without it the answer is
`401 {"success":false,"error":"unauthorized"}`, for unknown paths as well. **Every `curl` example below
needs it:**

```bash
curl -H "X-Claude-Api-Key: $CLAUDE_API_KEY" http://localhost:3000/api/calls
```

If `CLAUDE_API_KEY` is unset or shorter than 32 characters the API is **locked**: every route except
`/health` answers 401 and the startup log says so. The process still starts, because it is also the SIP
endpoint and a missing variable must not take inbound calls down.

`POST /api/outbound-call` only dials a destination listed in `OUTBOUND_ALLOWED_TO` (comma-separated, **exact
string match**, no normalisation: `15555550100` is not `+15555550100`). Unset or empty means every call is
refused (`403 destination_not_allowed`). An entry is either E.164 (`+15555550100`) or a bare digit dial
string such as an extension; wildcards and anything else are ignored and counted in the startup log.

```bash
OUTBOUND_ALLOWED_TO=+15555550100,+15555550101
```

The generated audio and beeps the local FreeSWITCH fetches over `http://127.0.0.1:3000/audio-files/...` and
`/static/...` are the one exemption: a `GET`/`HEAD` of a single file name from the local host needs no key.

## Endpoints

### POST /api/outbound-call

Initiate an outbound call.

**Request:**

```json
{
  "to": "+15551234567",
  "message": "Hello from your server",
  "mode": "announce",
  "device": "Morpheus",
  "callerId": "+15559876543",
  "timeoutSeconds": 30,
  "webhookUrl": "https://example.com/webhook"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `to` | Yes | Phone number in E.164 format |
| `message` | Yes | Text to speak (max 1000 chars) |
| `mode` | No | `announce` (default) or `conversation` |
| `device` | No | Device name for voice/personality |
| `callerId` | No | Caller ID to display |
| `timeoutSeconds` | No | Ring timeout 5-120 (default: 30) |
| `webhookUrl` | No | URL for status callbacks |

**Response:**

```json
{
  "success": true,
  "callId": "abc123-uuid",
  "status": "queued",
  "message": "Call initiated"
}
```

### GET /api/call/:callId

Get status of a specific call.

**Response:**

```json
{
  "success": true,
  "callId": "abc123-uuid",
  "to": "+15551234567",
  "state": "completed",
  "mode": "announce",
  "createdAt": "2025-01-01T12:00:00.000Z",
  "answeredAt": "2025-01-01T12:00:05.234Z",
  "endedAt": "2025-01-01T12:00:15.678Z",
  "duration": 10
}
```

### GET /api/calls

List all active calls.

**Response:**

```json
{
  "success": true,
  "count": 2,
  "calls": [
    { "callId": "...", "to": "...", "state": "playing" },
    { "callId": "...", "to": "...", "state": "dialing" }
  ]
}
```

### POST /api/call/:callId/hangup

Manually hang up an active call.

**Response:**

```json
{
  "success": true,
  "message": "Call hangup initiated",
  "callId": "abc123-uuid"
}
```

## Call States

| State | Description |
|-------|-------------|
| `queued` | Call created, not yet dialing |
| `dialing` | SIP INVITE sent, waiting for answer |
| `playing` | Call answered, playing message |
| `completed` | Call finished successfully |
| `failed` | Call failed (busy, no answer, error) |

## Call Modes

### Announce Mode (Default)

Plays the message and hangs up:

```bash
curl -X POST http://localhost:3000/api/outbound-call \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15551234567",
    "message": "Alert: Your server storage is at 95 percent."
  }'
```

### Conversation Mode

Plays the message, then allows back-and-forth conversation:

```bash
curl -X POST http://localhost:3000/api/outbound-call \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15551234567",
    "message": "Alert: Your server storage is at 95 percent. Would you like me to clean up old logs?",
    "mode": "conversation",
    "device": "Morpheus"
  }'
```

## Webhooks

If `webhookUrl` is provided, POST requests are sent on state changes:

```json
{
  "callId": "abc123-uuid",
  "state": "completed",
  "to": "+15551234567",
  "duration": 15,
  "timestamp": "2025-01-01T12:00:15.678Z"
}
```

## Error Responses

```json
{
  "success": false,
  "error": "Invalid phone number format"
}
```

| Error | Cause |
|-------|-------|
| `Invalid phone number format` | `to` not in E.164 format |
| `Message is required` | Missing `message` field |
| `Message too long` | Message exceeds 1000 chars |
| `Call not found` | Invalid `callId` |
| `service_unavailable` | SIP/media server not ready |
| `unauthorized` (401) | Missing or wrong `X-Claude-Api-Key`, or the API is locked (no usable `CLAUDE_API_KEY`) |
| `destination_not_allowed` (403) | `to` is not an exact match for an entry in `OUTBOUND_ALLOWED_TO` |

## Failure Reasons

When a call fails, the `reason` field indicates why:

| Reason | Description |
|--------|-------------|
| `busy` | Recipient busy (SIP 486) |
| `no_answer` | No answer within timeout (SIP 480/408) |
| `not_found` | Number not found (SIP 404) |
| `rejected` | Call rejected (SIP 603) |
| `service_unavailable` | Server error (SIP 503) |

## Examples

### Basic Alert

```bash
curl -X POST http://localhost:3000/api/outbound-call \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15551234567",
    "message": "Your backup job completed successfully."
  }'
```

### With Webhook

```bash
curl -X POST http://localhost:3000/api/outbound-call \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15551234567",
    "message": "Server alert: High CPU usage detected.",
    "webhookUrl": "https://n8n.example.com/webhook/call-status"
  }'
```

### Check Status

```bash
# Get call status
curl http://localhost:3000/api/call/abc123-uuid

# List all active calls
curl http://localhost:3000/api/calls
```

## Integration Examples

### Home Assistant

```yaml
rest_command:
  call_alert:
    url: "http://VOICE_SERVER:3000/api/outbound-call"
    method: POST
    content_type: "application/json"
    payload: '{"to": "+15551234567", "message": "{{ message }}"}'
```

### n8n Workflow: Automated Alert System

This example workflow queries a device for status, then calls you if there's a problem.

```
┌──────────────┐     ┌──────────────┐     ┌──────────┐     ┌──────────────┐
│   Trigger    │ ──▶ │ Query Device │ ──▶ │ If Alert │ ──▶ │  Call User   │
│ (Schedule)   │     │ POST /query  │     │  Needed  │     │ POST /call   │
└──────────────┘     └──────────────┘     └──────────┘     └──────────────┘
```

**Node 1: Trigger**
- Use Schedule Trigger (e.g., every 5 minutes) or Manual Trigger for testing

**Node 2: HTTP Request - Query Device**
```
Method: POST
URL: http://YOUR_SERVER:3000/api/query
Body (JSON):
```
```json
{
  "query": "Check the system health. Alert me if anything needs attention.",
  "device": "Morpheus",
  "format": "json",
  "schema": {
    "queryType": "alert_check",
    "requiredFields": ["call_user", "reason"],
    "fieldGuidance": {
      "call_user": "Boolean - true if something needs attention",
      "reason": "One sentence explaining the situation, under 30 words"
    }
  },
  "timeout": 120
}
```

**Node 3: If - Check Alert Condition**
```
Condition: {{ $json.structured.call_user }} equals true
```

**Node 4: HTTP Request - Make Call (True branch only)**
```
Method: POST
URL: http://YOUR_SERVER:3000/api/outbound-call
Body (JSON):
```
```json
{
  "to": "YOUR_EXTENSION",
  "message": "Hey! {{ $json.structured.reason }}. Want details?",
  "mode": "conversation",
  "device": "Morpheus"
}
```

**How it works:**
1. Trigger fires (on schedule or manually)
2. Queries your device with a structured schema request
3. Device returns JSON with `call_user: true/false` and `reason`
4. If `call_user` is true, initiates outbound call in conversation mode
5. You answer and can ask follow-up questions

### Shell Script

```bash
#!/bin/bash
PHONE="+15551234567"
MESSAGE="Disk space critical on server1"

curl -s -X POST http://localhost:3000/api/outbound-call \
  -H "Content-Type: application/json" \
  -d "{\"to\": \"$PHONE\", \"message\": \"$MESSAGE\"}"
```
