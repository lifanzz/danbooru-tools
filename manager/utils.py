"""Shared utility functions for request/response handling and file operations."""
import os, json, hashlib, re, time


def send_json(handler, data, status=200):
    """Send a JSON response."""
    payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    # Keep-alive clients (including the manager page) need a definite body
    # length so fetch(...).json() can resolve immediately.
    handler.send_header('Content-Length', str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def read_body(handler):
    """Parse JSON body from request."""
    content_length = int(handler.headers['Content-Length'])
    post_data = handler.rfile.read(content_length)
    return json.loads(post_data)


def generate_group_id(name_cn):
    """Generate a URL-safe ID from Chinese name using hash."""
    safe = re.sub(r'[^\w]', '_', name_cn).strip('_')
    if not safe or safe == '_':
        safe = 'custom'
    uid = hashlib.md5((name_cn + str(time.time())).encode()).hexdigest()[:6]
    return f'cg_{safe}_{uid}'


