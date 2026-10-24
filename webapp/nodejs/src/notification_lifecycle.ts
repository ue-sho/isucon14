let initializing = false;
let resetting = false;
let activeRequests = 0;
const closeHandlers = new Set<() => Promise<void>>();
export const isResetting = () => resetting;
export const isInitializing = () => initializing;
export const enterRequest = () => {
  activeRequests++;
};
export const leaveRequest = () => {
  activeRequests--;
};
export function onReset(handler: () => Promise<void>) {
  closeHandlers.add(handler);
  return () => {
    closeHandlers.delete(handler);
  };
}
export async function beginReset() {
  if (resetting) throw new Error("reset already running");
  resetting = true;
  initializing = true;
  try {
    const deadline = Date.now() + 2000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...closeHandlers].map((close) => close())),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("notification streams did not drain")),
            2000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    while (activeRequests > 0) {
      if (Date.now() >= deadline) throw new Error("requests did not drain");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) {
    resetting = false;
    throw error;
  }
}
export function finishReset() {
  initializing = false;
  resetting = false;
}
// A failed reset keeps traffic stopped, but permits a subsequent initialize retry.
export function failReset() {
  resetting = false;
}
