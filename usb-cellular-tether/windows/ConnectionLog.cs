namespace UsbCellularTether.Windows;

internal static class ConnectionLog
{
    private static readonly object Lock = new();

    public static bool VerboseEnabled { get; set; }

    public static string Path => System.IO.Path.Combine(AppContext.BaseDirectory, "connection.log");

    public static void Write(string area, string message)
    {
        lock (Lock)
        {
            var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{area}] {message}{Environment.NewLine}";
            File.AppendAllText(Path, line);
            if (VerboseEnabled)
            {
                AppLog.Write($"[{area}] {message}");
            }
        }
    }

    public static void WriteException(string area, Exception exception)
    {
        Write(area, exception.ToString());
    }
}
