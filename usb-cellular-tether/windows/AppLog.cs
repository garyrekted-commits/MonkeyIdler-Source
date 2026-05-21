namespace UsbCellularTether.Windows;

internal static class AppLog
{
    private static readonly object Lock = new();

    public static string Path => System.IO.Path.Combine(AppContext.BaseDirectory, "companion.log");

    public static void Write(string message)
    {
        lock (Lock)
        {
            File.AppendAllText(Path, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}");
        }
    }

    public static void Write(Exception exception)
    {
        Write(exception.ToString());
    }
}
