"""Reject non-loopback sockets in evaluation Python processes, including children."""
import ipaddress
import sys

def offline_socket(event, args):
    if event != "socket.connect":
        return
    address = args[1]
    if not isinstance(address, tuple):
        return
    host = address[0]
    if host == "localhost":
        return
    try:
        allowed = ipaddress.ip_address(host).is_loopback
    except ValueError:
        allowed = False
    if not allowed:
        raise RuntimeError("Offline evaluation blocked external socket")

sys.addaudithook(offline_socket)
