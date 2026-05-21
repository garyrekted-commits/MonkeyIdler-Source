namespace UsbCellularTether.Windows;

internal interface ITetherSession : IAsyncDisposable
{
    Task RunAsync(CancellationToken cancellationToken);
}
