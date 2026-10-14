import os
import subprocess

from server import PromptServer, web


@PromptServer.instance.routes.post("/image-prompt-extractor/open-folder")
async def open_folder_in_explorer(request):
    """Open a user-selected, existing local folder in Windows Explorer."""
    try:
        requested_path = str((await request.json()).get("path", "")).strip()
        if not requested_path:
            return web.json_response({"success": False, "error": "请先填写文件夹路径。"}, status=400)
        resolved_path = os.path.abspath(os.path.expandvars(os.path.expanduser(requested_path)))
        if not os.path.isdir(resolved_path):
            return web.json_response({"success": False, "error": f"不是有效文件夹：{resolved_path}"}, status=400)
        subprocess.Popen(["explorer.exe", resolved_path])
        return web.json_response({"success": True, "path": resolved_path})
    except Exception as exc:
        print(f"[ImagePromptExtractor] Failed to open folder: {exc}")
        return web.json_response({"success": False, "error": str(exc)}, status=500)


@PromptServer.instance.routes.post("/image-prompt-extractor/choose-folder")
async def choose_folder(request):
    """Show Windows' native folder picker and return the chosen absolute path."""
    script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$dialog.Description = '选择图片提示词提取器要记住的文件夹'; "
        "$dialog.ShowNewFolderButton = $true; "
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
        "  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
        "  [Console]::Write($dialog.SelectedPath) "
        "}"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=300,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "系统文件夹选择框启动失败。")
        selected_path = result.stdout.strip()
        return web.json_response({"success": bool(selected_path), "path": selected_path})
    except subprocess.TimeoutExpired:
        return web.json_response({"success": False, "error": "选择文件夹超时。"}, status=504)
    except Exception as exc:
        print(f"[ImagePromptExtractor] Failed to choose folder: {exc}")
        return web.json_response({"success": False, "error": str(exc)}, status=500)


class ImagePromptExtractor:
    """Passes the prompt text selected in the browser to one STRING output."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # This is a widget (not a node socket).  The web extension hides it
                # and fills it as soon as the user chooses an image.
                "prompt_text": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "extract"
    CATEGORY = "image/metadata"

    def extract(self, prompt_text):
        return (prompt_text or "",)


class ImagePromptExtractorImageInput:
    """Pass through an IMAGE while the browser resolves its PNG metadata immediately."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                # The frontend fills this without queueing.  Keep it a hidden
                # widget so saved workflows still retain the extracted text.
                "prompt_text": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "prompt")
    FUNCTION = "extract"
    CATEGORY = "image/metadata"

    def extract(self, image, prompt_text):
        return (image, prompt_text or "")


NODE_CLASS_MAPPINGS = {
    "ImagePromptExtractor": ImagePromptExtractor,
    "ImagePromptExtractorImageInput": ImagePromptExtractorImageInput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImagePromptExtractor": "图片提示词提取器（即时）",
    "ImagePromptExtractorImageInput": "图片提示词提取器（图像输入·即时）",
}
