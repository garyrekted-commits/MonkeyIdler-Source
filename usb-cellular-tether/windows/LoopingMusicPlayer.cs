using NAudio.Wave;

namespace UsbCellularTether.Windows;

internal sealed class LoopingMusicPlayer : IDisposable
{
    private static readonly string[] CandidateFileNames =
    [
        "Emerald Hill Zone.mp3",
        "Sonic the Hedgehog 2 OST  Emerald Hill Zone.mp3",
    ];

    private readonly string _displayName;
    private readonly AudioFileReader _reader;
    private readonly WaveOutEvent _output;
    private bool _disposed;

    private LoopingMusicPlayer(string path, string displayName)
    {
        _displayName = displayName;
        _reader = new AudioFileReader(path);
        _output = new WaveOutEvent();
        _output.PlaybackStopped += OnPlaybackStopped;
        _output.Init(_reader);
        _output.Play();
    }

    public string DisplayName => _displayName;

    public static LoopingMusicPlayer? TryStartFromCompanionFolder()
    {
        foreach (var fileName in CandidateFileNames)
        {
            var path = Path.Combine(AppContext.BaseDirectory, fileName);
            if (!File.Exists(path))
            {
                continue;
            }

            try
            {
                return new LoopingMusicPlayer(path, fileName);
            }
            catch
            {
                // Try the next candidate name.
            }
        }

        return null;
    }

    private void OnPlaybackStopped(object? sender, StoppedEventArgs e)
    {
        if (_disposed || e.Exception is not null)
        {
            return;
        }

        try
        {
            _reader.Position = 0;
            _output.Play();
        }
        catch
        {
            // Companion is shutting down or the device was removed.
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _output.PlaybackStopped -= OnPlaybackStopped;
        _output.Stop();
        _output.Dispose();
        _reader.Dispose();
    }
}
