using System.Net;
using System.Net.Sockets;

namespace UsbCellularTether.Windows;

internal static class QuickSelfTest
{
    private const int PcProxyPort = 18080;

    public static async Task<(bool Ok, string Summary)> RunAsync(CancellationToken cancellationToken)
    {
        var lines = new List<string>();
        var ok = true;

        try
        {
            var adb = new AdbClient();
            var devices = await adb.GetDevicesAsync(cancellationToken);
            var authorized = devices.FirstOrDefault(device => device.State == "device");
            if (authorized is null)
            {
                ok = false;
                lines.Add("FAIL ADB: no authorized phone (check USB debugging prompt).");
            }
            else
            {
                lines.Add($"PASS ADB: {authorized.Serial} authorized.");

                await adb.StartAndroidTetherServiceAsync(authorized.Serial, cancellationToken);
                lines.Add("PASS Android: tether service start command sent.");

                try
                {
                    await adb.RemoveForwardAsync(authorized.Serial, PcProxyPort, cancellationToken);
                }
                catch
                {
                    // Stale forward may not exist.
                }

                await adb.ForwardAsync(authorized.Serial, PcProxyPort, 28080, cancellationToken);
                lines.Add($"PASS ADB forward: tcp:{PcProxyPort} -> phone:28080.");

                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(5));
                using var tcp = new TcpClient();
                await tcp.ConnectAsync(IPAddress.Loopback, PcProxyPort, timeout.Token);
                lines.Add($"PASS Proxy TCP: 127.0.0.1:{PcProxyPort} reachable.");

                using var client = new HttpClient(new HttpClientHandler
                {
                    Proxy = new WebProxy($"http://127.0.0.1:{PcProxyPort}"),
                    UseProxy = true,
                    ServerCertificateCustomValidationCallback = (_, _, _, _) => true,
                })
                {
                    Timeout = TimeSpan.FromSeconds(8),
                };
                using var response = await client.GetAsync(
                    "https://cloudflare-dns.com/dns-query?name=example.com&type=A",
                    cancellationToken);
                var body = await response.Content.ReadAsStringAsync(cancellationToken);
                if (body.Contains("\"Answer\"", StringComparison.OrdinalIgnoreCase))
                {
                    lines.Add("PASS DNS: DoH through phone proxy returned an A record.");
                }
                else
                {
                    ok = false;
                    lines.Add("FAIL DNS: DoH response did not include an answer.");
                }
            }
        }
        catch (Exception ex)
        {
            ok = false;
            lines.Add("FAIL: " + ex.Message);
            ConnectionLog.WriteException("QUICKTEST", ex);
        }

        return (ok, string.Join(Environment.NewLine, lines));
    }
}
