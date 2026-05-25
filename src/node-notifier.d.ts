declare module "node-notifier" {
  interface NotificationOptions {
    title: string;
    message: string;
  }

  interface Notifier {
    notify(options: NotificationOptions): void;
  }

  const notifier: Notifier;
  export default notifier;
}
