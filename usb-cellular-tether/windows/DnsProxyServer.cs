using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;

namespace UsbCellularTether.Windows;

internal sealed class DnsProxyServer : IAsyncDisposable
{
    private readonly string _listenAddress;
    private readonly string _proxyEndpoint;
    private readonly Action<string> _onLog;
    private readonly bool _allowWindowsDnsFallback;
    private readonly HttpClient _client;
    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new(StringComparer.OrdinalIgnoreCase);
    private UdpClient? _udpClient;
    private CancellationTokenSource? _cancellation;
    private Task? _serverTask;

    public DnsProxyServer(
        string listenAddress,
        string proxyEndpoint,
        Action<string> onLog,
        bool allowWindowsDnsFallback = true)
    {
        _listenAddress = listenAddress;
        _proxyEndpoint = proxyEndpoint;
        _onLog = onLog;
        _allowWindowsDnsFallback = allowWindowsDnsFallback;
        _client = new HttpClient(new HttpClientHandler
        {
            Proxy = new WebProxy(_proxyEndpoint),
            UseProxy = true,
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true,
        })
        {
            Timeout = TimeSpan.FromSeconds(4),
        };
    }

    public void Start()
    {
        _cancellation = new CancellationTokenSource();
        if (!IPAddress.TryParse(_listenAddress, out var bindAddress))
        {
            throw new InvalidOperationException($"Invalid tunnel DNS bind address: {_listenAddress}");
        }

        _udpClient = new UdpClient(new IPEndPoint(bindAddress, 53));
        _serverTask = Task.Run(() => RunAsync(_cancellation.Token));
        _onLog($"DNS proxy listening on {_listenAddress}:53 (tunnel interface only).");
    }

    public async ValueTask DisposeAsync()
    {
        _cancellation?.Cancel();
        _udpClient?.Dispose();
        if (_serverTask is not null)
        {
            try
            {
                await _serverTask;
            }
            catch
            {
                // Closing UdpClient is the normal shutdown path.
            }
        }
        _cancellation?.Dispose();
        _client.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && _udpClient is not null)
        {
            UdpReceiveResult receive;
            try
            {
                receive = await _udpClient.ReceiveAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }

            _ = Task.Run(() => HandleQueryAsync(receive, cancellationToken), cancellationToken);
        }
    }

    private async Task HandleQueryAsync(UdpReceiveResult receive, CancellationToken cancellationToken)
    {
        try
        {
            var query = DnsQuery.Parse(receive.Buffer);
            var addresses = query.Type == 1
                ? await ResolveARecordsAsync(query.Name, cancellationToken)
                : [];
            var response = BuildResponse(query, addresses);
            if (_udpClient is not null)
            {
                await _udpClient.SendAsync(response, receive.RemoteEndPoint, cancellationToken);
            }
        }
        catch (Exception ex)
        {
            _onLog("DNS proxy error: " + ex.Message);
        }
    }

    private async Task<IReadOnlyList<IPAddress>> ResolveARecordsAsync(string name, CancellationToken cancellationToken)
    {
        if (_cache.TryGetValue(name, out var cached) && cached.ExpiresAt > DateTimeOffset.UtcNow)
        {
            return cached.Addresses;
        }

        var addresses = await ResolveViaDohWithRetriesAsync(name, cancellationToken);
        if (addresses.Count == 0 && _allowWindowsDnsFallback)
        {
            addresses = await ResolveViaWindowsDnsAsync(name, cancellationToken);
        }

        _cache[name] = new CacheEntry(addresses, DateTimeOffset.UtcNow.AddMinutes(2));
        return addresses;
    }

    private async Task<IReadOnlyList<IPAddress>> ResolveViaDohWithRetriesAsync(string name, CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= 4; attempt++)
        {
            var addresses = await ResolveViaDohAsync(name, cancellationToken);
            if (addresses.Count > 0 || attempt == 4)
            {
                return addresses;
            }

            _onLog($"DNS over phone proxy retry {attempt}/4 for {name}.");
            await Task.Delay(TimeSpan.FromMilliseconds(500 * attempt), cancellationToken);
        }

        return [];
    }

    private async Task<IReadOnlyList<IPAddress>> ResolveViaDohAsync(string name, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://cloudflare-dns.com/dns-query?name={Uri.EscapeDataString(name)}&type=A");
            request.Headers.TryAddWithoutValidation("accept", "application/dns-json");

            using var response = await _client.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();
            await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var json = await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken);

            if (!json.RootElement.TryGetProperty("Answer", out var answers))
            {
                return [];
            }

            var result = new List<IPAddress>();
            foreach (var answer in answers.EnumerateArray())
            {
                if (answer.TryGetProperty("type", out var type) &&
                    type.GetInt32() == 1 &&
                    answer.TryGetProperty("data", out var data) &&
                    IPAddress.TryParse(data.GetString(), out var address))
                {
                    result.Add(address);
                }
            }
            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            _onLog(_allowWindowsDnsFallback
                ? $"DNS over phone proxy failed for {name}; using Windows DNS fallback. {ex.Message}"
                : $"DNS over phone proxy failed for {name}; Wi-Fi fallback is disabled for tunnel safety. {ex.Message}");
            return [];
        }
    }

    private static async Task<IReadOnlyList<IPAddress>> ResolveViaWindowsDnsAsync(string name, CancellationToken cancellationToken)
    {
        try
        {
            var addresses = await Dns.GetHostAddressesAsync(name, AddressFamily.InterNetwork, cancellationToken);
            return addresses;
        }
        catch
        {
            return [];
        }
    }

    private sealed record CacheEntry(IReadOnlyList<IPAddress> Addresses, DateTimeOffset ExpiresAt);

    private sealed record DnsQuery(byte[] Raw, string Name, ushort Type, int QuestionEndOffset)
    {
        public static DnsQuery Parse(byte[] raw)
        {
            if (raw.Length < 12) throw new InvalidOperationException("DNS query too short.");

            var labels = new List<string>();
            var offset = 12;
            while (offset < raw.Length)
            {
                var length = raw[offset++];
                if (length == 0) break;
                if (offset + length > raw.Length) throw new InvalidOperationException("Invalid DNS name.");
                labels.Add(System.Text.Encoding.ASCII.GetString(raw, offset, length));
                offset += length;
            }

            if (offset + 4 > raw.Length) throw new InvalidOperationException("Invalid DNS question.");
            var type = BinaryPrimitives.ReadUInt16BigEndian(raw.AsSpan(offset, 2));
            return new DnsQuery(raw, string.Join('.', labels), type, offset + 4);
        }
    }

    private static byte[] BuildResponse(DnsQuery query, IReadOnlyList<IPAddress> addresses)
    {
        using var stream = new MemoryStream();
        stream.Write(query.Raw.AsSpan(0, query.QuestionEndOffset));

        var response = stream.ToArray();
        response[2] = 0x81;
        response[3] = 0x80;
        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(6, 2), (ushort)addresses.Count);

        stream.SetLength(0);
        stream.Write(response);
        foreach (var address in addresses)
        {
            var bytes = address.GetAddressBytes();
            stream.WriteByte(0xC0);
            stream.WriteByte(0x0C);
            stream.WriteByte(0x00);
            stream.WriteByte(0x01);
            stream.WriteByte(0x00);
            stream.WriteByte(0x01);
            stream.Write([0x00, 0x00, 0x00, 0x3C]);
            stream.WriteByte(0x00);
            stream.WriteByte(0x04);
            stream.Write(bytes);
        }

        return stream.ToArray();
    }

}
