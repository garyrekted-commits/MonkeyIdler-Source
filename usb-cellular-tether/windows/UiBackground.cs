namespace UsbCellularTether.Windows;

/// <summary>Runs work off the WinForms UI thread and marshals UI updates back safely.</summary>
internal static class UiBackground
{
    public static void Run(Form form, Func<Task> work)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await work().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                try
                {
                    if (!form.IsDisposed)
                    {
                        form.BeginInvoke(() =>
                        {
                            AppLog.Write(ex);
                            ConnectionLog.WriteException("UI", ex);
                        });
                    }
                }
                catch
                {
                    // Form may be closing.
                }
            }
        });
    }
}
