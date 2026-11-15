"""Evaluation-only routing. The actual provider key stays in the proxy process."""
import os
import urllib.request
from urllib.parse import urlparse

_original = urllib.request.urlopen


def _routed(request, *args, **kwargs):
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    parsed = urlparse(url)
    if parsed.hostname == "api.deepseek.com":
        destination = os.environ["SF_EVAL_PROXY"] + parsed.path
        request = urllib.request.Request(destination, data=request.data,
                                         headers=dict(request.headers), method=request.get_method())
    return _original(request, *args, **kwargs)


urllib.request.urlopen = _routed
