# Apple Container Networking Setup (macOS)

Apple Container's vmnet networking may require manual configuration for containers to access the internet. Without this, containers can communicate with the host but fail on DNS, HTTPS, or outbound API access.

## Quick Setup

Run these two commands with `sudo`:

```bash
# 1. Enable IP forwarding so the host routes container traffic
sudo sysctl -w net.inet.ip.forwarding=1

# 2. Enable NAT so container traffic is masqueraded through your internet interface
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -
```

Replace `en0` with your active internet interface. Check with:

```bash
route get 8.8.8.8 | grep interface
```

## Making It Persistent

These settings reset on reboot. To make them persistent:

IP forwarding in `/etc/sysctl.conf`:

```text
net.inet.ip.forwarding=1
```

NAT rules in `/etc/pf.conf`:

```text
nat on en0 from 192.168.64.0/24 to any -> (en0)
```

Then reload:

```bash
sudo pfctl -f /etc/pf.conf
```

## IPv6 DNS Issue

DNS resolvers often return IPv6 (`AAAA`) records before IPv4 (`A`) records. If your NAT path only handles IPv4, Node.js inside containers may try IPv6 first and fail.

NanoClaw's container runtime prefers IPv4 with:

```text
NODE_OPTIONS=--dns-result-order=ipv4first
```

## Verification

```bash
# Check IP forwarding is enabled
sysctl net.inet.ip.forwarding

# Test container internet access
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.openai.com/v1/models
# Expected: 401

# Check bridge interface (exists only while a container is running)
ifconfig bridge100
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `curl: (28) Connection timed out` | IP forwarding disabled | `sudo sysctl -w net.inet.ip.forwarding=1` |
| HTTP works, HTTPS times out | IPv6 DNS resolution | Add `NODE_OPTIONS=--dns-result-order=ipv4first` |
| `Could not resolve host` | DNS not forwarded | Check `bridge100` exists and verify `pfctl` NAT rules |
| Container reaches host but not internet | NAT interface mismatch | Replace `en0` with the real outbound interface |

## Notes

- this document is about Apple Container networking only
- for the current runtime contract, follow `README.md`, `docs/docker-sandboxes.md`, and the live container runner code
