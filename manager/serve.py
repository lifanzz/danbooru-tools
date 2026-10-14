"""Minimal HTTP server with JSON MIME type support and tag management API."""
import ctypes, http.server, socketserver, os, subprocess, threading, time, socket
from urllib.parse import urlsplit
from urllib.error import URLError
from urllib.request import urlopen

from config import PORT, DIRECTORY, HOST
from utils import send_json
from catalogue_store import snapshot
from api.tag_api import handle_add_tag, handle_rename_tag, handle_delete_tag, handle_delete_tags, handle_toggle_tag_pin, handle_upsert_character_preset
from api.model_api import handle_save_model, handle_delete_model, handle_reorder_models, handle_upload_model_image, handle_refresh_models, handle_refresh_models_status, handle_model_hash, handle_open_model_category_folder
from api.group_api import (
    handle_create_group, handle_delete_group, handle_rename_group, handle_update_group, handle_reorder_categories, handle_move_tags_to_category,
    handle_add_tags_to_group, handle_remove_tag_from_group,
    handle_toggle_group_search, handle_move_tags_to_group,
)
from api.settings_api import handle_get_settings, handle_save_settings, handle_open_url
from api.illustrated_note_api import handle_list_illustrated_notes, handle_save_illustrated_note, handle_save_illustrated_group, handle_upload_illustrated_image, handle_move_illustrated_group, handle_delete_illustrated_group


SERVER_INSTANCE = None
CLOSE_WEBUI_REQUESTED = False
CLOSE_WEBUI_ACKNOWLEDGED = False
EDGE_DEBUG_PORT = 9222
EDGE_PROFILE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", DIRECTORY), "DanbooruTagManagerEdge")
EDGE_PATHS = (
    os.path.join(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
    os.path.join(os.environ.get("PROGRAMFILES", r"C:\Program Files"), "Microsoft", "Edge", "Application", "msedge.exe"),
)


def bring_manager_window_to_front(timeout_seconds: float = 3.0) -> bool:
    """Restore and foreground the dedicated Edge app window by its page title."""
    user32 = ctypes.windll.user32
    target = ctypes.c_void_p()

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def find_window(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title, length + 1)
            if 'Danbooru Tag Manager' in title.value or 'Danbooru 标签管理器' in title.value:
                target.value = hwnd
                return False
        return True

    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        target.value = None
        user32.EnumWindows(find_window, 0)
        if target.value:
            user32.ShowWindow(target.value, 9)  # SW_RESTORE
            user32.SetWindowPos(target.value, -1, 0, 0, 0, 0, 0x0001 | 0x0002)  # temporary topmost
            user32.SetForegroundWindow(target.value)
            user32.SetWindowPos(target.value, -2, 0, 0, 0, 0, 0x0001 | 0x0002)  # remove topmost state
            return True
        time.sleep(0.1)
    return False


def open_manager_window(url: str) -> bool:
    """Open Danbooru in its own debuggable Edge app window, not the daily browser."""
    edge_path = next((path for path in EDGE_PATHS if os.path.isfile(path)), None)
    if not edge_path:
        print("ERROR: Microsoft Edge was not found; cannot open the manager window.")
        return False
    try:
        subprocess.Popen(
            [
                edge_path,
                "--remote-debugging-address=127.0.0.1",
                f"--remote-debugging-port={EDGE_DEBUG_PORT}",
                f"--user-data-dir={EDGE_PROFILE_DIR}",
                "--no-first-run",
                f"--app={url}",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return bring_manager_window_to_front()
    except OSError as exc:
        print(f"ERROR: Could not start Danbooru Edge window: {exc}")
        return False


def handle_shutdown_server(handler):
    """Reply first, then leave serve_forever so the launching CMD can close."""
    send_json(handler, {'success': True, 'message': 'Danbooru 标签管理器正在关闭。'})

    def shutdown_later():
        time.sleep(0.15)
        if SERVER_INSTANCE is not None:
            SERVER_INSTANCE.shutdown()

    threading.Thread(target=shutdown_later, daemon=True).start()


def handle_prepare_close_webui(handler):
    """Let the page blank/close itself before another local service stops us."""
    global CLOSE_WEBUI_REQUESTED, CLOSE_WEBUI_ACKNOWLEDGED
    CLOSE_WEBUI_REQUESTED = True
    CLOSE_WEBUI_ACKNOWLEDGED = False
    send_json(handler, {'success': True})


def handle_close_webui_state(handler):
    send_json(handler, {'closing': CLOSE_WEBUI_REQUESTED, 'acknowledged': CLOSE_WEBUI_ACKNOWLEDGED})


def handle_close_webui_ack(handler):
    global CLOSE_WEBUI_ACKNOWLEDGED
    CLOSE_WEBUI_ACKNOWLEDGED = True
    send_json(handler, {'success': True})


def handle_cancel_close_webui(handler):
    """Clear a stale close request before opening a fresh manager window."""
    global CLOSE_WEBUI_REQUESTED, CLOSE_WEBUI_ACKNOWLEDGED
    CLOSE_WEBUI_REQUESTED = False
    CLOSE_WEBUI_ACKNOWLEDGED = False
    send_json(handler, {'success': True})

# Route table: path -> handler function
ROUTES = {
    '/api/illustrated-notes': handle_list_illustrated_notes,
    '/api/save-illustrated-note': handle_save_illustrated_note,
    '/api/save-illustrated-group': handle_save_illustrated_group,
    '/api/move-illustrated-group': handle_move_illustrated_group,
    '/api/delete-illustrated-group': handle_delete_illustrated_group,
    '/api/upload-illustrated-image': handle_upload_illustrated_image,
    '/api/add-tag': handle_add_tag,
    '/api/create-group': handle_create_group,
    '/api/delete-group': handle_delete_group,
    '/api/rename-group': handle_rename_group,
    '/api/update-group': handle_update_group,
    '/api/reorder-categories': handle_reorder_categories,
    '/api/move-tags-to-category': handle_move_tags_to_category,
    '/api/add-tags-to-group': handle_add_tags_to_group,
    '/api/remove-tag-from-group': handle_remove_tag_from_group,
    '/api/toggle-group-search': handle_toggle_group_search,
    '/api/move-tags-to-group': handle_move_tags_to_group,
    '/api/rename-tag': handle_rename_tag,
    '/api/delete-tag': handle_delete_tag,
    '/api/delete-tags': handle_delete_tags,
    '/api/toggle-tag-pin': handle_toggle_tag_pin,
    '/api/upsert-character-preset': handle_upsert_character_preset,
    '/api/save-model': handle_save_model,
    '/api/delete-model': handle_delete_model,
    '/api/reorder-models': handle_reorder_models,
    '/api/upload-model-image': handle_upload_model_image,
    '/api/refresh-models': handle_refresh_models,
    '/api/refresh-models-status': handle_refresh_models_status,
    '/api/model-hash': handle_model_hash,
    '/api/open-model-category-folder': handle_open_model_category_folder,
    '/api/save-settings': handle_save_settings,
    '/api/open-url': handle_open_url,
    '/api/shutdown-server': handle_shutdown_server,
    '/api/prepare-close-webui': handle_prepare_close_webui,
    '/api/close-webui-state': handle_close_webui_state,
    '/api/close-webui-ack': handle_close_webui_ack,
    '/api/cancel-close-webui': handle_cancel_close_webui,
}


class JSONHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.json': 'application/json; charset=utf-8',
    }

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        request_path = urlsplit(self.path).path
        if request_path.startswith('/assets/') or request_path.startswith('/api/') or (request_path.startswith('/data/') and request_path.endswith('.json')) or request_path in ('/', '/index.html', '/illustrated.html'):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        print(f"  {args[0]}")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        handler = ROUTES.get(self.path)
        if handler:
            handler(self)
        else:
            send_json(self, {"error": "Not found"}, 404)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/settings':
            handle_get_settings(self)
        elif path in ('/api/catalogue', '/data/tags.json', '/data/groups.json'):
            try:
                catalogue = snapshot()
                send_json(self, catalogue if path == '/api/catalogue' else catalogue['tags' if path.endswith('tags.json') else 'groups'])
            except (OSError, ValueError) as exc:
                send_json(self, {'error': str(exc)}, 500)
        else:
            super().do_GET()


class ThreadingHTTPServer(socketserver.ThreadingTCPServer):
    """Keep model saves responsive while the UI loads many group JSON files."""
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64


# ── Startup ──

def probe_existing_manager() -> bool:
    """Return True if the port already serves this manager's index page."""
    try:
        with urlopen(f"http://127.0.0.1:{PORT}/", timeout=2) as resp:
            if resp.status != 200:
                return False
            head = resp.read(4096).decode('utf-8', errors='replace')
            return 'Danbooru 标签管理器' in head or 'Danbooru Tag Manager' in head
    except (URLError, OSError, ValueError):
        return False


os.chdir(DIRECTORY)

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind((HOST, PORT))
    sock.close()
except OSError:
    if probe_existing_manager():
        print(f"Danbooru 标签管理器已在运行（端口 {PORT}），本次启动自动退出。")
        bring_manager_window_to_front()
        exit(0)
    print(f"ERROR: Port {PORT} is already in use!")
    print(f"Another server may be running. Close it first or change PORT in config.py.")
    if os.environ.get("DANBOORU_OPEN_BROWSER", "1") != "0":
        input("Press Enter to exit...")
    exit(1)

with ThreadingHTTPServer((HOST, PORT), JSONHandler) as httpd:
    SERVER_INSTANCE = httpd
    url = os.environ.get("DANBOORU_OPEN_URL") or f"http://localhost:{PORT}"
    print(f"Server running at {url}")
    print(f"Serving from: {DIRECTORY}")
    print("Press Ctrl+C to stop\n")

    def open_browser():
        time.sleep(0.5)
        open_manager_window(url)

    if os.environ.get("DANBOORU_OPEN_BROWSER", "1") != "0":
        threading.Thread(target=open_browser, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
