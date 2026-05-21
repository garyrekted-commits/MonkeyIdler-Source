using System.Diagnostics;
using System.Drawing;
using System.Net.Http;
using System.Text.Json;
using System.Windows.Forms;

namespace UsbCellularTether.Windows;

internal sealed class MainForm : Form
{
    private const int PcPort = 18080;
    private const int PhonePort = 28080;
    private const string AppVersion = "1.0.32";
    private const string LatestReleaseApiUrl = "https://api.github.com/repos/garyrekted-commits/UsbCellularTether/releases/latest";
    private static readonly Color BackgroundColor = Color.FromArgb(21, 25, 38);
    private static readonly Color SurfaceColor = Color.FromArgb(31, 37, 55);
    private static readonly Color PrimaryTextColor = Color.FromArgb(238, 243, 255);
    private static readonly Color SecondaryTextColor = Color.FromArgb(150, 160, 185);
    private static readonly Color HealthyColor = Color.FromArgb(52, 211, 153);
    private static readonly Color DegradedColor = Color.FromArgb(250, 204, 21);
    private static readonly Color RecoveringColor = Color.FromArgb(251, 146, 60);
    private static readonly Color CyanColor = Color.FromArgb(45, 211, 232);
    private static readonly Color RedColor = Color.FromArgb(245, 82, 101);
    private static readonly Color PurpleColor = Color.FromArgb(129, 119, 255);

    private readonly CompanionSettings _settings = CompanionSettings.Load();
    private readonly Label _stateLabel = new();
    private readonly Label _healthLabel = new();
    private readonly Label _messageLabel = new();
    private readonly Label _rateLabel = new();
    private readonly Label _deviceLabel = new();
    private readonly Label _tunnelLabel = new();
    private readonly Label _proxyLabel = new();
    private readonly Label _trafficLabel = new();
    private readonly Label _outLabel = new();
    private readonly Label _inLabel = new();
    private readonly TextBox _networkStatsBox = new();
    private readonly TextBox _logBox = new();
    private readonly System.Windows.Forms.Timer _networkStatsTimer = new();
    private readonly System.Windows.Forms.Timer _phonePollTimer = new();
    private readonly Button _startButton = new();
    private readonly Button _stopButton = new();
    private readonly Button _quickTestButton = new();
    private readonly Button _updateButton = new();
    private readonly Button _repairButton = new();
    private readonly Button _diagnosticsButton = new();
    private readonly Button _copyLogsButton = new();
    private readonly CheckBox _autoStartCheck = new();
    private readonly CheckBox _disableWifiCheck = new();
    private readonly CheckBox _verboseLogCheck = new();
    private readonly CheckBox _trayOnCloseCheck = new();
    private readonly CheckBox _restoreOnStopCheck = new();
    private readonly CheckBox _detailedStatsCheck = new();
    private readonly TransferRateTracker _rateTracker = new();
    private NotifyIcon? _trayIcon;

    private bool _autoStartInProgress;
    private bool _sessionStartInProgress;
    private DateTimeOffset _autoStartCooldownUntil = DateTimeOffset.MinValue;
    private bool _phonePollPaused;
    private bool _diagnosticsInProgress;
    private bool _quickTestInProgress;
    private bool _stopping;
    private string? _lastLoggedStatusMessage;
    private string? _lastStatusMessage;
    private TrafficStats _lastTunnelTraffic = TrafficStats.Empty;
    private ConnectionHealth _health = ConnectionHealth.Idle;
    private bool _tunnelActive;
    private long _lastNetworkStatsLogTicks;

    private CancellationTokenSource? _cancellation;
    private ITetherSession? _session;
    private Task? _sessionTask;
    private readonly SemaphoreSlim _uiOperationGate = new(1, 1);

    public MainForm()
    {
        Text = $"Cellular USB Link v{AppVersion}";
        Width = 920;
        Height = 720;
        MinimumSize = new Size(720, 560);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = BackgroundColor;

        ApplySettingsToUi();
        BuildUi();
        ConfigureTrayIcon();
        ClearStaleLocalProxy();
        ApplyStatus(TunnelStatus.Idle);
        ConfigureAutoStartPolling();
        ConfigureNetworkStatsPolling();
        Shown += OnMainFormShown;
        UiBackground.Run(this, RefreshLastDeviceSerialAsync);
        WarnIfNewerSideBySideBuildPresent();
    }

    private void OnMainFormShown(object? sender, EventArgs e)
    {
        UiBackground.Run(this, async () =>
        {
            TunnelPortGuard.KillDuplicateCompanionProcesses();
            await TunnelPortGuard.ReleaseStaleTunnelServicesAsync(CancellationToken.None).ConfigureAwait(false);
        });
    }

    private void RunOnUiThread(Action action)
    {
        if (IsDisposed) return;
        if (InvokeRequired) BeginInvoke(action);
        else action();
    }

    private void RunOnUiThreadSync(Action action)
    {
        if (IsDisposed) return;
        if (InvokeRequired) Invoke(action);
        else action();
    }

    private void SetBusyMessage(string message)
    {
        RunOnUiThread(() => _messageLabel.Text = message);
    }

    private void WarnIfNewerSideBySideBuildPresent()
    {
        try
        {
            var folder = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var runningExe = Path.Combine(folder, "UsbCellularTether.Windows.exe");
            var runningVersion = File.Exists(runningExe)
                ? System.Diagnostics.FileVersionInfo.GetVersionInfo(runningExe).ProductVersion ?? "unknown"
                : "unknown";
            if (!runningVersion.StartsWith(AppVersion, StringComparison.Ordinal))
            {
                AppendLog($"WARNING: You launched v{runningVersion.Trim()} but v{AppVersion} is installed. Close this window and run Apply-v{AppVersion}.ps1 or UsbCellularTether.Windows.{AppVersion}.exe.");
            }
        }
        catch
        {
            // Optional startup hint only.
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_session is not null)
        {
            if (_trayOnCloseCheck.Checked)
            {
                e.Cancel = true;
                Hide();
                _trayIcon?.ShowBalloonTip(3000, "Cellular USB Link", "Still tethering in the background. Double-click the tray icon to reopen.", ToolTipIcon.Info);
                return;
            }

            e.Cancel = true;
            WindowState = FormWindowState.Minimized;
            AppendLog("Tunnel still running. Press Stop, or enable minimize-to-tray in Options.");
            return;
        }

        _phonePollTimer.Stop();
        _networkStatsTimer.Stop();
        SaveSettingsFromUi();
        _trayIcon?.Dispose();
        base.OnFormClosing(e);
    }

    private void ApplySettingsToUi()
    {
        ConnectionLog.VerboseEnabled = _settings.VerboseLogging;
        _autoStartCheck.Checked = _settings.AutoStartWhenPhoneConnects;
        _disableWifiCheck.Checked = _settings.DisableWifiWhenActive;
        _verboseLogCheck.Checked = _settings.VerboseLogging;
        _trayOnCloseCheck.Checked = _settings.MinimizeToTrayWhileRunning;
        _restoreOnStopCheck.Checked = _settings.RestoreInternetOnStop;
        _detailedStatsCheck.Checked = _settings.ShowDetailedAdapterStats;
    }

    private void SaveSettingsFromUi()
    {
        _settings.AutoStartWhenPhoneConnects = _autoStartCheck.Checked;
        _settings.DisableWifiWhenActive = _disableWifiCheck.Checked;
        _settings.VerboseLogging = _verboseLogCheck.Checked;
        _settings.MinimizeToTrayWhileRunning = _trayOnCloseCheck.Checked;
        _settings.RestoreInternetOnStop = _restoreOnStopCheck.Checked;
        _settings.ShowDetailedAdapterStats = _detailedStatsCheck.Checked;
        ConnectionLog.VerboseEnabled = _settings.VerboseLogging;
        _settings.Save();
    }

    private void BuildUi()
    {
        var bottomBar = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 96,
            BackColor = BackgroundColor,
            Padding = new Padding(18, 4, 18, 10),
        };

        var scrollHost = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = BackgroundColor,
            Padding = new Padding(0),
        };

        var main = new TableLayoutPanel
        {
            ColumnCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Dock = DockStyle.Top,
            Padding = new Padding(18, 18, 18, 8),
            BackColor = BackgroundColor,
        };
        main.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        main.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        main.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        main.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        main.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        main.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        main.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        main.RowStyles.Add(new RowStyle(SizeType.Absolute, 100));

        var header = new TableLayoutPanel { Dock = DockStyle.Top, ColumnCount = 3, Height = 52, BackColor = BackgroundColor };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20));
        header.Controls.Add(new Label
        {
            Text = "Cellular USB Link",
            ForeColor = PrimaryTextColor,
            Font = new Font(Font.FontFamily, 20, FontStyle.Bold),
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
        }, 0, 0);
        _healthLabel.Font = new Font(Font.FontFamily, 10, FontStyle.Bold);
        _healthLabel.ForeColor = SecondaryTextColor;
        _healthLabel.Dock = DockStyle.Fill;
        _healthLabel.TextAlign = ContentAlignment.MiddleCenter;
        _healthLabel.Text = "IDLE";
        header.Controls.Add(_healthLabel, 1, 0);
        header.Controls.Add(new Label
        {
            Text = $"v{AppVersion}",
            ForeColor = SecondaryTextColor,
            BackColor = SurfaceColor,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
        }, 2, 0);

        var setupPanel = CreatePanel(SurfaceColor, new Padding(14, 10, 14, 10));
        setupPanel.Controls.Add(new Label
        {
            Text = "Setup: (1) USB cable + unlock phone  (2) Accept USB debugging  (3) Start Tether on Android app  (4) Press Start here (run as Administrator)",
            ForeColor = SecondaryTextColor,
            Dock = DockStyle.Fill,
            AutoSize = true,
            MaximumSize = new Size(820, 0),
        });

        var hero = CreatePanel(SurfaceColor, new Padding(16, 12, 16, 10));
        _stateLabel.Font = new Font(Font.FontFamily, 17, FontStyle.Bold);
        _stateLabel.ForeColor = PrimaryTextColor;
        _stateLabel.Dock = DockStyle.Top;
        _stateLabel.AutoSize = true;
        _messageLabel.ForeColor = SecondaryTextColor;
        _messageLabel.Dock = DockStyle.Top;
        _messageLabel.AutoSize = true;
        _messageLabel.MaximumSize = new Size(820, 0);
        hero.Controls.Add(_messageLabel);
        hero.Controls.Add(_stateLabel);

        var cards = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, BackColor = BackgroundColor };
        for (var i = 0; i < 4; i++) cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        cards.Controls.Add(CreateStatCard("TUNNEL TOTAL", _trafficLabel, RedColor), 0, 0);
        cards.Controls.Add(CreateStatCard("OUT (PC→PHONE)", _outLabel, PurpleColor), 1, 0);
        cards.Controls.Add(CreateStatCard("IN (PHONE→PC)", _inLabel, CyanColor), 2, 0);
        cards.Controls.Add(CreateStatCard("LIVE RATE", _rateLabel, Color.FromArgb(34, 197, 94)), 3, 0);
        _rateLabel.Text = "0 B/s";

        var optionsPanel = CreatePanel(SurfaceColor, new Padding(14, 10, 14, 8));
        var optionsTitle = new Label { Text = "Options", ForeColor = PrimaryTextColor, Font = new Font(Font.FontFamily, 10, FontStyle.Bold), Dock = DockStyle.Top, AutoSize = true };
        var optionsFlow = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = SurfaceColor };
        ConfigureOptionCheck(_autoStartCheck, "Auto-start tunnel when authorized phone connects");
        ConfigureOptionCheck(_disableWifiCheck, "Disable Wi-Fi while tunnel is active (restored on Stop / Restore Internet)");
        ConfigureOptionCheck(_verboseLogCheck, "Verbose logging (connection.log + companion.log detail)");
        ConfigureOptionCheck(_trayOnCloseCheck, "Minimize to tray while tunnel is running");
        ConfigureOptionCheck(_restoreOnStopCheck, "Restore normal internet when stopping tunnel");
        ConfigureOptionCheck(_detailedStatsCheck, "Show detailed Windows adapter statistics");
        _verboseLogCheck.CheckedChanged += (_, _) => { ConnectionLog.VerboseEnabled = _verboseLogCheck.Checked; SaveSettingsFromUi(); };
        _detailedStatsCheck.CheckedChanged += (_, _) => { SaveSettingsFromUi(); RefreshNetworkStatsDisplay(); };
        optionsFlow.Controls.AddRange([_autoStartCheck, _disableWifiCheck, _verboseLogCheck, _trayOnCloseCheck, _restoreOnStopCheck, _detailedStatsCheck]);
        optionsPanel.Controls.Add(optionsFlow);
        optionsPanel.Controls.Add(optionsTitle);

        var statsPanel = CreatePanel(SurfaceColor, new Padding(12));
        statsPanel.Controls.Add(new Label
        {
            Text = "Network statistics (tunnel + Windows wintun adapter)",
            ForeColor = SecondaryTextColor,
            Font = new Font(Font.FontFamily, 9, FontStyle.Bold),
            Dock = DockStyle.Top,
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 6),
        });
        _networkStatsBox.Multiline = true;
        _networkStatsBox.ReadOnly = true;
        _networkStatsBox.ScrollBars = ScrollBars.Vertical;
        _networkStatsBox.Dock = DockStyle.Fill;
        _networkStatsBox.Height = 56;
        _networkStatsBox.BackColor = Color.FromArgb(17, 21, 33);
        _networkStatsBox.ForeColor = PrimaryTextColor;
        _networkStatsBox.Font = new Font("Consolas", 9f);
        _networkStatsBox.BorderStyle = BorderStyle.None;
        _networkStatsBox.Text = "Press Start to see live adapter and tunnel counters.";
        statsPanel.Controls.Add(_networkStatsBox);

        var statusGrid = CreatePanel(SurfaceColor, new Padding(14));
        var statusRows = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true, BackColor = SurfaceColor };
        statusRows.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        statusRows.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        AddStatusRow(statusRows, "Device", _deviceLabel);
        AddStatusRow(statusRows, "Tunnel", _tunnelLabel);
        AddStatusRow(statusRows, "Proxy", _proxyLabel);
        statusGrid.Controls.Add(statusRows);

        _logBox.Multiline = true;
        _logBox.ReadOnly = true;
        _logBox.ScrollBars = ScrollBars.Vertical;
        _logBox.Dock = DockStyle.Fill;
        _logBox.BackColor = Color.FromArgb(17, 21, 33);
        _logBox.ForeColor = SecondaryTextColor;
        _logBox.BorderStyle = BorderStyle.None;
        var logPanel = new Panel { Dock = DockStyle.Fill, BackColor = SurfaceColor, Padding = new Padding(12), Height = 100 };
        logPanel.Controls.Add(_logBox);

        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Top,
            AutoSize = true,
            WrapContents = true,
            BackColor = BackgroundColor,
            Padding = new Padding(0, 0, 0, 4),
            MinimumSize = new Size(680, 40),
        };
        StyleButton(_startButton, "Start", CyanColor);
        StyleButton(_stopButton, "Stop", RedColor);
        StyleButton(_quickTestButton, "Quick Test", Color.FromArgb(34, 197, 94), 100);
        StyleButton(_diagnosticsButton, "Full Diagnostics", Color.FromArgb(58, 130, 246), 130);
        StyleButton(_copyLogsButton, "Copy Log Paths", Color.FromArgb(70, 80, 105), 120);
        StyleButton(_repairButton, "Restore Internet", Color.FromArgb(70, 80, 105), 130);
        StyleButton(_updateButton, "Install / Update", PurpleColor, 120);
        _startButton.Click += (_, _) => UiBackground.Run(this, StartSessionAsync);
        _stopButton.Click += (_, _) => UiBackground.Run(this, StopSessionAsync);
        _quickTestButton.Click += (_, _) => UiBackground.Run(this, RunQuickTestAsync);
        _diagnosticsButton.Click += (_, _) => UiBackground.Run(this, RunDiagnosticsAsync);
        _copyLogsButton.Click += (_, _) => CopyLogPaths();
        _repairButton.Click += (_, _) => UiBackground.Run(this, RestoreInternetButtonAsync);
        _updateButton.Click += (_, _) => UiBackground.Run(this, OpenLatestWindowsUpdateAsync);
        buttons.Controls.AddRange([_updateButton, _repairButton, _copyLogsButton, _diagnosticsButton, _quickTestButton, _stopButton, _startButton]);

        var helpLink = new LinkLabel
        {
            Text = "ADB authorization help (revoke + replug USB if phone never prompts)",
            LinkColor = CyanColor,
            ActiveLinkColor = CyanColor,
            AutoSize = true,
            BackColor = BackgroundColor,
            Dock = DockStyle.Bottom,
        };
        helpLink.LinkClicked += (_, _) => Process.Start(new ProcessStartInfo("https://developer.android.com/studio/command-line/adb#Enabling") { UseShellExecute = true });

        main.Controls.Add(header);
        main.Controls.Add(setupPanel);
        main.Controls.Add(hero);
        main.Controls.Add(cards);
        main.Controls.Add(optionsPanel);
        main.Controls.Add(statsPanel);
        main.Controls.Add(statusGrid);
        main.Controls.Add(logPanel);

        scrollHost.Controls.Add(main);
        void SyncScrollWidth()
        {
            var width = scrollHost.ClientSize.Width;
            if (width > 0)
            {
                main.Width = Math.Max(400, width - SystemInformation.VerticalScrollBarWidth - 4);
            }
        }
        scrollHost.Resize += (_, _) => SyncScrollWidth();
        SyncScrollWidth();

        bottomBar.Controls.Add(helpLink);
        bottomBar.Controls.Add(buttons);
        Controls.Add(scrollHost);
        Controls.Add(bottomBar);
    }

    private void ConfigureOptionCheck(CheckBox check, string text)
    {
        check.Text = text;
        check.AutoSize = true;
        check.ForeColor = SecondaryTextColor;
        check.BackColor = SurfaceColor;
        check.Margin = new Padding(0, 0, 0, 4);
        check.CheckedChanged += (_, _) => SaveSettingsFromUi();
    }

    private void ConfigureTrayIcon()
    {
        _trayIcon = new NotifyIcon
        {
            Text = "Cellular USB Link",
            Icon = SystemIcons.Application,
            Visible = false,
        };
        _trayIcon.DoubleClick += (_, _) =>
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        };
    }

    private static void AddStatusRow(TableLayoutPanel grid, string name, Label value)
    {
        var row = grid.RowCount++;
        grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        grid.Controls.Add(new Label { Text = name, AutoSize = true, ForeColor = SecondaryTextColor, BackColor = SurfaceColor, Font = new Font(SystemFonts.DefaultFont, FontStyle.Bold) }, 0, row);
        value.AutoSize = true;
        value.ForeColor = PrimaryTextColor;
        value.BackColor = SurfaceColor;
        grid.Controls.Add(value, 1, row);
    }

    private static Panel CreatePanel(Color color, Padding padding) =>
        new() { Dock = DockStyle.Fill, BackColor = color, Padding = padding, Margin = new Padding(0, 0, 0, 10) };

    private static Panel CreateStatCard(string title, Label value, Color accent)
    {
        value.ForeColor = PrimaryTextColor;
        value.Font = new Font(SystemFonts.DefaultFont.FontFamily, 15, FontStyle.Bold);
        value.TextAlign = ContentAlignment.MiddleCenter;
        value.Dock = DockStyle.Fill;
        value.BackColor = accent;
        var label = new Label { Text = title, ForeColor = Color.FromArgb(235, 240, 255), BackColor = accent, Dock = DockStyle.Top, Height = 30, TextAlign = ContentAlignment.MiddleCenter };
        return new Panel { Dock = DockStyle.Fill, BackColor = accent, Margin = new Padding(0, 0, 8, 10), Padding = new Padding(8), Controls = { value, label } };
    }

    private static void StyleButton(Button button, string text, Color color, int width = 100)
    {
        button.Text = text;
        button.Width = width;
        button.Height = 36;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = color;
        button.ForeColor = Color.White;
    }

    private async Task StartSessionAsync()
    {
        if (_session is not null || _sessionStartInProgress || _stopping) return;
        if (!await _uiOperationGate.WaitAsync(0).ConfigureAwait(false)) return;

        _sessionStartInProgress = true;
        _phonePollPaused = true;
        RunOnUiThread(SaveSettingsFromUi);
        RunOnUiThread(() =>
        {
            _startButton.Enabled = false;
            _stopButton.Enabled = true;
            _rateTracker.Reset();
            SetBusyMessage("Preparing tunnel — cleaning ports and routes…");
        });

        try
        {
            using var prepareTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            try
            {
                await TunnelPortGuard.ReleaseStaleTunnelServicesAsync(prepareTimeout.Token).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                RunOnUiThread(() => AppendLog("Pre-start cleanup: " + ex.Message));
            }

            RunOnUiThread(() => AppendLog("Starting cellular USB tunnel..."));
            await RestoreNormalInternetCoreAsync(logOnlyOnError: true).ConfigureAwait(false);

            ITetherSession? session = null;
            CancellationTokenSource? cancellation = null;
            RunOnUiThreadSync(() =>
            {
                cancellation = new CancellationTokenSource();
                _cancellation = cancellation;
                session = CreateSession(status => RunOnUiThread(() => ApplyStatus(status)));
                _session = session;
                _networkStatsTimer.Start();
                SetBusyMessage("Connecting to phone and starting adapter…");
            });

            if (session is null || cancellation is null)
            {
                throw new InvalidOperationException("Tunnel session could not be created.");
            }

            var sessionRef = session;
            var token = cancellation.Token;
            _sessionTask = Task.Run(async () =>
            {
                try
                {
                    await sessionRef.RunAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    RunOnUiThread(() => AppendLog("Stopped."));
                }
                catch (Exception ex)
                {
                    RunOnUiThread(() =>
                    {
                        AppendLog("Fatal error: " + ex.Message);
                        ApplyStatus(new TunnelStatus("Error", ex.Message, Health: ConnectionHealth.Error));
                    });
                    await StopSessionAsync().ConfigureAwait(false);
                }
            });
        }
        catch (Exception ex)
        {
            RunOnUiThread(() =>
            {
                AppendLog("Start failed: " + ex.Message);
                ApplyStatus(new TunnelStatus("Error", ex.Message, Health: ConnectionHealth.Error));
            });
            await StopSessionAsync().ConfigureAwait(false);
        }
        finally
        {
            if (_session is null)
            {
                _sessionStartInProgress = false;
                _phonePollPaused = false;
            }

            _uiOperationGate.Release();
        }
    }

    private async Task StopSessionAsync()
    {
        if (_stopping) return;
        if (!await _uiOperationGate.WaitAsync(0).ConfigureAwait(false)) return;

        _stopping = true;
        _sessionStartInProgress = false;
        _phonePollPaused = false;
        RunOnUiThread(() =>
        {
            _networkStatsTimer.Stop();
            SetBusyMessage("Stopping tunnel…");
        });

        try
        {
            _cancellation?.Cancel();
            var sessionTask = _sessionTask;
            var session = _session;
            _sessionTask = null;
            _session = null;
            if (session is not null) await session.DisposeAsync().ConfigureAwait(false);
            if (sessionTask is not null)
            {
                try { await Task.WhenAny(sessionTask, Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false); }
                catch { /* logged via UI */ }
            }

            _cancellation?.Dispose();
            _cancellation = null;
            RunOnUiThread(() => _autoStartCheck.Enabled = true);
            _autoStartCooldownUntil = DateTimeOffset.UtcNow.AddSeconds(10);
            try
            {
                await TunnelPortGuard.ReleaseStaleTunnelServicesAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                // Cleanup is best-effort during stop.
            }

            RunOnUiThread(() => ApplyStatus(TunnelStatus.Idle));
            if (_restoreOnStopCheck.Checked)
            {
                await RestoreNormalInternetCoreAsync(logOnlyOnError: true).ConfigureAwait(false);
            }
        }
        finally
        {
            _stopping = false;
            _uiOperationGate.Release();
        }
    }

    private async Task RestoreNormalInternetCoreAsync(bool logOnlyOnError = false)
    {
        RunOnUiThread(() => _repairButton.Enabled = false);
        try
        {
            if (!logOnlyOnError) RunOnUiThread(() => AppendLog("Restoring normal Windows internet settings..."));
            await Tun2SocksEngine.RestoreNormalInternetAsync(CancellationToken.None).ConfigureAwait(false);
            RunOnUiThread(ClearStaleLocalProxy);
            if (!logOnlyOnError) RunOnUiThread(() => AppendLog("Normal internet settings restored."));
        }
        catch (Exception ex)
        {
            RunOnUiThread(() => AppendLog("Restore internet failed: " + ex.Message));
        }
        finally
        {
            RunOnUiThread(() => _repairButton.Enabled = true);
        }
    }

    private Task RestoreNormalInternetAsync(bool logOnlyOnError = false) =>
        RestoreNormalInternetCoreAsync(logOnlyOnError);

    private async Task RestoreInternetButtonAsync()
    {
        if (_session is not null) { AppendLog("Stopping tunnel before restoring normal internet..."); await StopSessionAsync(); return; }
        await RestoreNormalInternetAsync();
    }

    private async Task RunQuickTestAsync()
    {
        if (_quickTestInProgress) return;
        if (!await _uiOperationGate.WaitAsync(0).ConfigureAwait(false)) return;
        _quickTestInProgress = true;
        RunOnUiThread(() =>
        {
            _quickTestButton.Enabled = false;
            SetBusyMessage("Running quick test…");
            AppendLog("Running quick test (ADB, forward, proxy, DNS)...");
        });
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var (ok, summary) = await QuickSelfTest.RunAsync(timeout.Token).ConfigureAwait(false);
            RunOnUiThread(() =>
            {
                AppendLog(summary);
                if (!ok) ApplyHealth(ConnectionHealth.Degraded, "Quick test found issues — see log.");
            });
        }
        catch (Exception ex)
        {
            RunOnUiThread(() => AppendLog("Quick test failed: " + ex.Message));
        }
        finally
        {
            _quickTestInProgress = false;
            RunOnUiThread(() => _quickTestButton.Enabled = true);
            _uiOperationGate.Release();
        }
    }

    private async Task RunDiagnosticsAsync()
    {
        if (_diagnosticsInProgress) return;
        if (!await _uiOperationGate.WaitAsync(0).ConfigureAwait(false)) return;
        _diagnosticsInProgress = true;
        RunOnUiThread(() =>
        {
            _diagnosticsButton.Enabled = false;
            _startButton.Enabled = false;
            SetBusyMessage("Running full diagnostics…");
            AppendLog("Running full diagnostics (~1 minute)...");
        });
        try
        {
            using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(2));
            var path = await new TunnelDiagnostics(
                message => RunOnUiThread(() => AppendLog(message)),
                _session is not null).RunAsync(cancellation.Token).ConfigureAwait(false);
            RunOnUiThread(() =>
            {
                Clipboard.SetText(path);
                AppendLog("Diagnostics saved. Path copied to clipboard: " + path);
            });
        }
        catch (Exception ex)
        {
            RunOnUiThread(() => AppendLog("Diagnostics failed: " + ex.Message));
            ConnectionLog.WriteException("DIAG", ex);
        }
        finally
        {
            _diagnosticsInProgress = false;
            RunOnUiThread(() =>
            {
                _diagnosticsButton.Enabled = true;
                _startButton.Enabled = _session is null;
            });
            _uiOperationGate.Release();
        }
    }

    private void CopyLogPaths()
    {
        var text = $"connection.log: {ConnectionLog.Path}{Environment.NewLine}companion.log: {AppLog.Path}";
        Clipboard.SetText(text);
        AppendLog("Copied log file paths to clipboard.");
    }

    private ITetherSession CreateSession(Action<TunnelStatus> onStatus)
    {
        _autoStartCheck.Enabled = false;
        ClearStaleLocalProxy();
        return new AdapterTunnelSession(new AdbClient(), onStatus, _disableWifiCheck.Checked);
    }

    private void ConfigureAutoStartPolling()
    {
        _phonePollTimer.Interval = 2000;
        _phonePollTimer.Tick += (_, _) => UiBackground.Run(this, AutoStartIfPhoneConnectedAsync);
        _phonePollTimer.Start();
    }

    private async Task AutoStartIfPhoneConnectedAsync()
    {
        if (!_autoStartCheck.Checked || _session is not null || _autoStartInProgress || _sessionStartInProgress || _stopping || _phonePollPaused) return;
        if (DateTimeOffset.UtcNow < _autoStartCooldownUntil) return;
        _autoStartInProgress = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var devices = await new AdbClient().GetDevicesAsync(timeout.Token).ConfigureAwait(false);
            var device = devices.FirstOrDefault(candidate => candidate.State == "device");
            if (device is null) return;
            _settings.LastDeviceSerial = device.Serial;
            _settings.Save();
            RunOnUiThread(() =>
            {
                _deviceLabel.Text = device.Serial + " (last seen)";
                AppendLog($"Phone connected: {device.Serial}. Auto-starting tunnel.");
            });
            await StartSessionAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            RunOnUiThread(() => AppendLog("Auto-start failed: " + ex.Message));
        }
        finally { _autoStartInProgress = false; }
    }

    private async Task RefreshLastDeviceSerialAsync()
    {
        if (!string.IsNullOrWhiteSpace(_settings.LastDeviceSerial))
        {
            RunOnUiThread(() => _deviceLabel.Text = _settings.LastDeviceSerial + " (last)");
        }

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var devices = await new AdbClient().GetDevicesAsync(timeout.Token).ConfigureAwait(false);
            var device = devices.FirstOrDefault(candidate => candidate.State == "device");
            if (device is not null)
            {
                _settings.LastDeviceSerial = device.Serial;
                _settings.Save();
                RunOnUiThread(() => _deviceLabel.Text = device.Serial);
            }
        }
        catch { /* optional at startup */ }
    }

    private void ConfigureNetworkStatsPolling()
    {
        _networkStatsTimer.Interval = 2000;
        _networkStatsTimer.Tick += (_, _) =>
        {
            if (_session is null) return;
            UiBackground.Run(this, () => RefreshNetworkStatsCoreAsync(logSnapshot: true));
        };
    }

    private async Task RefreshNetworkStatsCoreAsync(bool logSnapshot = false)
    {
        var adapter = await Task.Run(NetworkAdapterStatsCollector.CollectWintun).ConfigureAwait(false);
        var traffic = _lastTunnelTraffic;
        var rate = TransferRateTracker.FormatRate(_rateTracker.Update(traffic));
        var statusMessage = _lastStatusMessage;
        var tunnelActive = _tunnelActive;
        var detailed = false;
        RunOnUiThreadSync(() => detailed = _detailedStatsCheck.Checked);

        RunOnUiThread(() => ApplyNetworkStatsUi(adapter, traffic, rate, statusMessage, tunnelActive, detailed, logSnapshot));
    }

    private void RefreshNetworkStatsDisplay(bool logSnapshot = false) =>
        UiBackground.Run(this, () => RefreshNetworkStatsCoreAsync(logSnapshot));

    private void ApplyNetworkStatsUi(
        NetworkAdapterStats adapter,
        TrafficStats traffic,
        string rate,
        string? statusMessage,
        bool tunnelActive,
        bool detailed,
        bool logSnapshot)
    {
        _rateLabel.Text = rate;

        if (detailed)
        {
            _networkStatsBox.Text = adapter.ToDisplayBlock(traffic);
        }
        else
        {
            _networkStatsBox.Text =
                $"Tunnel: out {FormatBytes(traffic.BytesOut)} | in {FormatBytes(traffic.BytesIn)} | total {FormatBytes(traffic.Total)} | {rate}{Environment.NewLine}" +
                $"Windows ({adapter.Name}): out {FormatBytes(adapter.BytesSent)} | in {FormatBytes(adapter.BytesReceived)} | status {adapter.OperationalStatus}";
        }

        if (!string.IsNullOrWhiteSpace(statusMessage) && tunnelActive)
        {
            _messageLabel.Text = statusMessage + Environment.NewLine +
                $"Adapter {adapter.Name}: {FormatBytes(adapter.BytesReceived)} in / {FormatBytes(adapter.BytesSent)} out · {rate}";
        }

        if (logSnapshot && tunnelActive)
        {
            var now = Environment.TickCount64;
            if (now - _lastNetworkStatsLogTicks >= 15000)
            {
                _lastNetworkStatsLogTicks = now;
                ConnectionLog.Write("NET", adapter.ToSummaryLine());
                ConnectionLog.Write("NET", $"Tunnel SOCKS out={traffic.BytesOut} in={traffic.BytesIn} rate={rate}");
            }
        }
    }

    private void ApplyStatus(TunnelStatus status)
    {
        _lastStatusMessage = status.Message;
        _lastTunnelTraffic = status.Traffic ?? TrafficStats.Empty;
        _tunnelActive = status.TunnelActive;
        _health = status.Health;
        if (!string.IsNullOrWhiteSpace(status.DeviceSerial))
        {
            _settings.LastDeviceSerial = status.DeviceSerial;
            _settings.Save();
        }

        _stateLabel.Text = status.State;
        _messageLabel.Text = status.Message;
        _deviceLabel.Text = status.DeviceSerial ?? _settings.LastDeviceSerial ?? "Not connected";
        _tunnelLabel.Text = status.TunnelActive ? $"wintun → phone proxy (127.0.0.1:{PcPort})" : "Inactive";
        _proxyLabel.Text = status.ProxyEnabled ? $"127.0.0.1:{PcPort}" : "System proxy not used";
        _trafficLabel.Text = FormatBytes(_lastTunnelTraffic.Total);
        _outLabel.Text = FormatBytes(_lastTunnelTraffic.BytesOut);
        _inLabel.Text = FormatBytes(_lastTunnelTraffic.BytesIn);
        ApplyHealth(status.Health, status.State);
        _startButton.Enabled = _session is null;
        _stopButton.Enabled = _session is not null;
        RefreshNetworkStatsDisplay();

        if (!string.Equals(_lastLoggedStatusMessage, status.Message, StringComparison.Ordinal))
        {
            _lastLoggedStatusMessage = status.Message;
            AppendLog(status.Message);
        }
    }

    private void ApplyHealth(ConnectionHealth health, string state)
    {
        _health = health;
        (_healthLabel.ForeColor, _healthLabel.Text) = health switch
        {
            ConnectionHealth.Healthy => (HealthyColor, "● HEALTHY"),
            ConnectionHealth.Recovering => (RecoveringColor, "● RECOVERING"),
            ConnectionHealth.Degraded => (DegradedColor, "● DEGRADED"),
            ConnectionHealth.Error => (RedColor, "● ERROR"),
            _ => (SecondaryTextColor, "● IDLE"),
        };
        _stateLabel.ForeColor = health switch
        {
            ConnectionHealth.Healthy => HealthyColor,
            ConnectionHealth.Error => RedColor,
            ConnectionHealth.Recovering => RecoveringColor,
            ConnectionHealth.Degraded => DegradedColor,
            _ => PrimaryTextColor,
        };
    }

    private void AppendLog(string message)
    {
        AppLog.Write(message);
        _logBox.AppendText($"[{DateTime.Now:T}] {message}{Environment.NewLine}");
    }

    private async Task OpenLatestWindowsUpdateAsync()
    {
        RunOnUiThread(() => _updateButton.Enabled = false);
        RunOnUiThread(() => AppendLog("Checking GitHub for latest Windows build..."));
        try
        {
            var downloadUrl = await GetLatestAssetUrlAsync("Windows", ".zip").ConfigureAwait(false);
            Process.Start(new ProcessStartInfo(downloadUrl) { UseShellExecute = true });
            RunOnUiThread(() => AppendLog("Opened latest Windows ZIP download."));
        }
        catch (Exception ex)
        {
            RunOnUiThread(() => AppendLog("Update check failed: " + ex.Message));
            Process.Start(new ProcessStartInfo("https://github.com/garyrekted-commits/UsbCellularTether/releases/latest") { UseShellExecute = true });
        }
        finally { RunOnUiThread(() => _updateButton.Enabled = true); }
    }

    private static async Task<string> GetLatestAssetUrlAsync(string requiredNamePart, string extension)
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.UserAgent.ParseAdd("UsbCellularTether.Windows");
        await using var stream = await http.GetStreamAsync(LatestReleaseApiUrl);
        using var document = await JsonDocument.ParseAsync(stream);
        foreach (var asset in document.RootElement.GetProperty("assets").EnumerateArray())
        {
            var name = asset.GetProperty("name").GetString() ?? "";
            if (name.Contains(requiredNamePart, StringComparison.OrdinalIgnoreCase) && name.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
                return asset.GetProperty("browser_download_url").GetString() ?? throw new InvalidOperationException("Missing download URL.");
        }
        throw new InvalidOperationException("No Windows ZIP on latest release.");
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        var kib = bytes / 1024.0;
        if (kib < 1024) return $"{kib:F1} KiB";
        var mib = kib / 1024.0;
        if (mib < 1024) return $"{mib:F1} MiB";
        return $"{mib / 1024.0:F1} GiB";
    }

    private void ClearStaleLocalProxy()
    {
        try
        {
            if (WindowsProxySettings.ClearIfLocalProxy(PcPort))
                AppendLog("Cleared stale Windows proxy 127.0.0.1:18080.");
        }
        catch (Exception ex) { AppendLog("Proxy check: " + ex.Message); }
    }
}
