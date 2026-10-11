"""The Dot's VM proxy, as install.sh sets it up (it runs this as root on every boot when config.json has a proxy).

    python3 vmproxy.py <config.json> <output directory>

Writes, into the output directory, hev.yml (0600: the tunnel's settings, password included), up.sh (0700: the routes
and the DNS the tunnel sets once tun0 is up) and allow.nft (0600: the firewall that lets nothing leave but through the
tunnel). Prints nothing on success. Otherwise it writes nothing, prints the reason on stderr and exits with:

    3  the proxy is not socks5://[user:password@]host:port
    4  the proxy's host does not resolve to an IPv4 address
    5  the VM has no default IPv4 route through a gateway (the tunnel needs it to reach the proxy)

Whatever the reason, install.sh then puts a firewall in place that lets nothing out: the Dot never goes out directly
when it has a proxy.
"""
import json
import os
import socket
import subprocess
import sys
from urllib.parse import unquote, urlsplit

INVALID, UNRESOLVED, NO_ROUTE = 3, 4, 5


class Refused(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code = code


def proxy_url(config_path):
    with open(config_path) as f:
        raw = json.load(f).get("proxy") or ""
    try:
        url = urlsplit(raw.strip())
        port = url.port
    except ValueError as error:
        raise Refused(INVALID, f"the proxy is not socks5://[user:password@]host:port ({error})")
    if url.scheme != "socks5" or not url.hostname or not port:
        raise Refused(INVALID, "the proxy is not socks5://[user:password@]host:port")
    return url


def resolve(host, port):
    try:
        return socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    except OSError as error:
        raise Refused(UNRESOLVED, f"the proxy's host {host} does not resolve to an IPv4 address ({error})")


def default_route():
    """The gateway and the device of the default IPv4 route."""
    shown = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True, check=True).stdout
    words = shown.split()
    if "via" not in words or "dev" not in words:
        seen = shown.strip() or "none"
        raise Refused(NO_ROUTE, f"the VM has no default IPv4 route through a gateway (ip route shows: {seen})")
    return words[words.index("via") + 1], words[words.index("dev") + 1]


def files(url, address, gateway, device):
    q = json.dumps
    lines = [
        "tunnel:", "  name: tun0", "  mtu: 8500", "  ipv4: 198.18.0.1", "  post-up-script: /run/dot-vmproxy/up.sh",
        "socks5:", f"  address: {q(address)}", f"  port: {url.port}", "  udp: 'udp'",
    ]
    if url.username:
        lines += [f"  username: {q(unquote(url.username))}", f"  password: {q(unquote(url.password or ''))}"]
    lines += ["mapdns:", "  address: 198.18.0.2", "  port: 53", "  network: 100.64.0.0", "  netmask: 255.192.0.0", "  cache-size: 10000"]
    up = (
        "#!/bin/sh\n"
        f"ip route replace {address}/32 via {gateway} dev {device}\n"
        "ip route replace default dev tun0 metric 1\n"
        "resolvectl dns tun0 198.18.0.2 && resolvectl domain tun0 '~.' && resolvectl default-route tun0 yes\n"
        f"resolvectl default-route {device} no || true\n"
    )
    allow = (
        "table inet dot_vmproxy {\n chain out {\n  type filter hook output priority 0; policy drop;\n"
        "  oifname { \"lo\", \"tun0\" } accept\n  ct state established,related accept\n"
        f"  ip daddr {address} tcp dport {url.port} accept\n  ip daddr {address} meta l4proto udp accept\n"
        "  ip daddr 10.0.2.0/24 accept\n  udp dport 67 accept\n }\n}\n"
    )
    return [("hev.yml", "\n".join(lines) + "\n", 0o600), ("up.sh", up, 0o700), ("allow.nft", allow, 0o600)]


def write(out, name, text, mode):
    fd = os.open(os.path.join(out, name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(text.encode())


def main(config_path, out):
    try:
        url = proxy_url(config_path)
        address = resolve(url.hostname, url.port)
        gateway, device = default_route()
    except Refused as refused:
        print(refused, file=sys.stderr)
        return refused.code
    for name, text, mode in files(url, address, gateway, device):
        write(out, name, text, mode)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: vmproxy.py <config.json> <output directory>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
