using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace DanbooruTagManagerTray;

internal static class Program
{
    private const string MutexName = @"Local\DanbooruTagManagerTray.SingleInstance";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(false, MutexName);
        bool owned;
        try { owned = mutex.WaitOne(TimeSpan.Zero); }
        catch (AbandonedMutexException) { owned = true; }  // previous instance crashed; take over
        if (!owned) return;  // an instance is already running; exit silently

        try
        {
            ApplicationConfiguration.Initialize();
            Application.Run(new DanbooruTrayContext());
        }
        finally { mutex.ReleaseMutex(); }
    }
}

internal sealed class DanbooruTrayContext : ApplicationContext
{
    private static readonly int Port = int.TryParse(Environment.GetEnvironmentVariable("DANBOORU_PORT"), out var configuredPort) ? configuredPort : 9090;
    private readonly string _root = AppContext.BaseDirectory;
    private readonly NotifyIcon _icon;
    private readonly ToolStripMenuItem _openItem;
    private readonly System.Windows.Forms.Timer _statusTimer;
    private Process? _server;
    private bool _ownsServer;
    private bool _openOnReady = Environment.GetEnvironmentVariable("DANBOORU_OPEN_BROWSER") != "0";
    private const uint SwRestore = 9;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private static readonly IntPtr HwndTopmost = new(-1);
    private static readonly IntPtr HwndNotopmost = new(-2);

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);

    public DanbooruTrayContext()
    {
        _openItem = new ToolStripMenuItem("打开标签管理器", null, (_, _) => OpenManager()) { Enabled = false };
        var menu = new ContextMenuStrip();
        menu.Items.Add(_openItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出服务", null, (_, _) => ExitApplication());

        var iconPath = Path.Combine(_root, "Danbooru标签管理器.ico");
        _icon = new NotifyIcon
        {
            Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application,
            Text = "Danbooru 标签管理器（启动中）",
            ContextMenuStrip = menu,
            Visible = true
        };
        _icon.DoubleClick += (_, _) => OpenManager();

        _statusTimer = new System.Windows.Forms.Timer { Interval = 600 };
        _statusTimer.Tick += (_, _) => RefreshStatus();
        _statusTimer.Start();
        StartServerIfNeeded();
    }

    private static bool ServerReady()
    {
        try
        {
            using var client = new TcpClient();
            return client.ConnectAsync("127.0.0.1", Port).Wait(TimeSpan.FromMilliseconds(180));
        }
        catch { return false; }
    }

    private void StartServerIfNeeded()
    {
        if (ServerReady()) return;

        var python = Environment.GetEnvironmentVariable("DANBOORU_PYTHON") ?? "python.exe";
        var script = Path.Combine(_root, "serve.py");
        if (!File.Exists(script))
        {
            _icon.Text = "Danbooru 标签管理器（缺少启动文件）";
            return;
        }

        var serverStartInfo = new ProcessStartInfo
        {
            FileName = python,
            WorkingDirectory = _root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        serverStartInfo.Environment["DANBOORU_OPEN_BROWSER"] = "0";
        serverStartInfo.ArgumentList.Add(script);
        try { _server = Process.Start(serverStartInfo); }
        catch (Exception) { _icon.Text = "Danbooru 标签管理器（请安装 Python 或设置 DANBOORU_PYTHON）"; return; }
        _ownsServer = _server is not null;
    }

    private void RefreshStatus()
    {
        var ready = ServerReady();
        _openItem.Enabled = ready;
        _icon.Text = ready ? "Danbooru 标签管理器（右键打开）" : "Danbooru 标签管理器（启动中）";
        if (ready && _openOnReady)
        {
            _openOnReady = false;
            OpenManager();
        }
    }

    private void OpenManager()
    {
        if (!ServerReady()) return;

        const string edge = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
        AllowSetForegroundWindow(-1);
        Process.Start(new ProcessStartInfo
        {
            FileName = File.Exists(edge) ? edge : $"http://127.0.0.1:{Port}/",
            Arguments = File.Exists(edge)
                ? $"--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=\"{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DanbooruTagManagerEdge")}\" --no-first-run --app=http://127.0.0.1:{Port}/"
                : "",
            UseShellExecute = true
        });
        _ = Task.Run(BringManagerWindowToFront);
    }

    private static void BringManagerWindowToFront()
    {
        for (var attempt = 0; attempt < 30; attempt++)
        {
            IntPtr target = IntPtr.Zero;
            EnumWindows((hwnd, _) =>
            {
                if (!IsWindowVisible(hwnd)) return true;
                var length = GetWindowTextLength(hwnd);
                if (length == 0) return true;
                var title = new System.Text.StringBuilder(length + 1);
                GetWindowText(hwnd, title, title.Capacity);
                if (!title.ToString().Contains("Danbooru Tag Manager", StringComparison.Ordinal)
                    && !title.ToString().Contains("Danbooru 标签管理器", StringComparison.Ordinal)) return true;
                target = hwnd;
                return false;
            }, IntPtr.Zero);
            if (target != IntPtr.Zero)
            {
                ShowWindow(target, SwRestore);
                SetWindowPos(target, HwndTopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize);
                SetForegroundWindow(target);
                BringWindowToTop(target);
                SetWindowPos(target, HwndNotopmost, 0, 0, 0, 0, SwpNoMove | SwpNoSize);
                return;
            }
            Thread.Sleep(100);
        }
    }

    private void ExitApplication()
    {
        _statusTimer.Stop();
        if (_ownsServer && _server is { HasExited: false })
        {
            _server.Kill(entireProcessTree: true);
            _server.WaitForExit(1500);
        }
        _icon.Visible = false;
        _icon.Dispose();
        ExitThread();
    }
}
