using System.Threading;
using System.Windows.Forms;
using UsbCellularTether.Windows;

internal static class Program
{
    private const string SingleInstanceMutexName = "UsbCellularTether-Companion-SingleInstance";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, SingleInstanceMutexName, out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show(
                "Cellular USB Link is already running.\n\nClose the other window (check the system tray), then try again.",
                "Cellular USB Link",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        try
        {
            AppLog.Write("Companion starting.");
            Application.ThreadException += (_, args) =>
            {
                AppLog.Write(args.Exception);
                MessageBox.Show(args.Exception.Message, "USB Cellular Tether Error");
            };
            AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            {
                if (args.ExceptionObject is Exception exception)
                {
                    AppLog.Write(exception);
                }
                else
                {
                    AppLog.Write("Unhandled non-exception: " + args.ExceptionObject);
                }
            };

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
            AppLog.Write("Companion exited normally.");
        }
        catch (Exception ex)
        {
            AppLog.Write(ex);
            MessageBox.Show(ex.Message, "USB Cellular Tether Startup Error");
        }
    }
}
