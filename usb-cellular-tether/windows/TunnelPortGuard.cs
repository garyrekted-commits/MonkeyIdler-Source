using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace UsbCellularTether.Windows;

internal static class TunnelPortGuard
{
    private static readonly SemaphoreSlim StartGate = new(1, 1);
    private static readonly Regex NetstatPidRegex = new(@"\s+(\d+)\s*$", RegexOptions.Compiled);

    public const int DnsProxyPort = 53;
    public const int SocksPort = FullTunnelSocksServer.SocksPort;

    public static async Task<IDisposable> AcquireStartLockAsync(CancellationToken cancellationToken)
    {
        await StartGate.WaitAsync(cancellationToken);
        return new ReleaseOnDispose(StartGate);
    }

    private sealed class ReleaseOnDispose(SemaphoreSlim gate) : IDisposable
    {
        public void Dispose() => gate.Release();
    }

    public static async Task ReleaseStaleTunnelServicesAsync(CancellationToken cancellationToken)
    {
        KillDuplicateCompanionProcesses();

        foreach (var process in Process.GetProcessesByName("tun2socks"))
        {
            try
            {
                ConnectionLog.Write("GUARD", $"Killing stale tun2socks pid={process.Id}.");
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(cancellationToken);
            }
            catch (Exception ex)
            {
                ConnectionLog.Write("GUARD", $"Could not kill tun2socks pid={process.Id}: {ex.Message}");
            }
            finally
            {
                process.Dispose();
            }
        }

        await KillCompanionHoldersForTcpPortAsync(SocksPort, cancellationToken).ConfigureAwait(false);
        await KillCompanionHoldersForUdpPortAsync(DnsProxyPort, cancellationToken).ConfigureAwait(false);
        await WaitForTcpPortFreeAsync(SocksPort, cancellationToken);
        await WaitForUdpPortFreeAsync(DnsProxyPort, cancellationToken);
    }

    public static void KillDuplicateCompanionProcesses()
    {
        var currentPid = Environment.ProcessId;
        foreach (var process in Process.GetProcessesByName("UsbCellularTether.Windows"))
        {
            if (process.Id == currentPid)
            {
                continue;
            }

            try
            {
                ConnectionLog.Write("GUARD", $"Killing duplicate companion pid={process.Id}.");
                process.Kill(entireProcessTree: true);
                process.WaitForExit(3000);
            }
            catch (Exception ex)
            {
                ConnectionLog.Write("GUARD", $"Could not kill companion pid={process.Id}: {ex.Message}");
            }
            finally
            {
                process.Dispose();
            }
        }
    }

    private static async Task KillCompanionHoldersForTcpPortAsync(int port, CancellationToken cancellationToken)
    {
        foreach (var pid in await GetListeningPidsAsync(port, tcp: true, cancellationToken).ConfigureAwait(false))
        {
            if (!ShouldKillHolder(pid))
            {
                continue;
            }

            await TryKillProcessAsync(pid, $"TCP:{port}", cancellationToken);
        }
    }

    private static async Task KillCompanionHoldersForUdpPortAsync(int port, CancellationToken cancellationToken)
    {
        foreach (var pid in await GetListeningPidsAsync(port, tcp: false, cancellationToken).ConfigureAwait(false))
        {
            if (!ShouldKillHolder(pid))
            {
                continue;
            }

            await TryKillProcessAsync(pid, $"UDP:{port}", cancellationToken);
        }
    }

    private static bool ShouldKillHolder(int pid)
    {
        if (pid <= 0 || pid == Environment.ProcessId)
        {
            return false;
        }

        try
        {
            using var process = Process.GetProcessById(pid);
            var name = process.ProcessName;
            return name.Equals("UsbCellularTether.Windows", StringComparison.OrdinalIgnoreCase)
                || name.Equals("tun2socks", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static async Task TryKillProcessAsync(int pid, string label, CancellationToken cancellationToken)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            ConnectionLog.Write("GUARD", $"Killing {label} holder pid={pid} ({process.ProcessName}).");
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (Exception ex)
        {
            ConnectionLog.Write("GUARD", $"Could not kill {label} holder pid={pid}: {ex.Message}");
        }
    }

    private static async Task<IEnumerable<int>> GetListeningPidsAsync(int port, bool tcp, CancellationToken cancellationToken)
    {
        var portToken = $":{port}";
        var result = await ProcessRunner.RunAsync(
            "netstat.exe",
            tcp ? "-ano -p tcp" : "-ano -p udp",
            cancellationToken).ConfigureAwait(false);

        var pids = new HashSet<int>();
        foreach (var line in result.Stdout.Split('\n', '\r'))
        {
            if (!line.Contains(portToken, StringComparison.Ordinal))
            {
                continue;
            }

            if (tcp && !line.Contains("LISTENING", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var match = NetstatPidRegex.Match(line);
            if (match.Success && int.TryParse(match.Groups[1].Value, out var pid))
            {
                pids.Add(pid);
            }
        }

        return pids;
    }

    private static async Task WaitForTcpPortFreeAsync(int port, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 12; attempt++)
        {
            if (await IsTcpPortFreeAsync(port))
            {
                ConnectionLog.Write("GUARD", $"TCP port {port} is free.");
                return;
            }

            ConnectionLog.Write("GUARD", $"TCP port {port} busy (attempt {attempt + 1}/12).");
            await Task.Delay(250, cancellationToken);
        }
    }

    private static async Task WaitForUdpPortFreeAsync(int port, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            if (await IsUdpPortFreeOnLoopbackAsync(port))
            {
                ConnectionLog.Write("GUARD", $"UDP port {port} on loopback is free.");
                return;
            }

            await Task.Delay(250, cancellationToken);
        }
    }

    private static async Task<bool> IsTcpPortFreeAsync(int port)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            listener.Start();
            listener.Stop();
            await Task.CompletedTask;
            return true;
        }
        catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
        {
            return false;
        }
    }

    private static async Task<bool> IsUdpPortFreeOnLoopbackAsync(int port)
    {
        try
        {
            using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, port));
            client.Close();
            await Task.CompletedTask;
            return true;
        }
        catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
        {
            return false;
        }
    }
}
