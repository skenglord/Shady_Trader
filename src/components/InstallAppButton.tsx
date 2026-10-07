import { useEffect, useState } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function InstallAppButton() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onInstallPrompt);
  }, []);

  if (!promptEvent) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        await promptEvent.prompt();
        await promptEvent.userChoice;
        setPromptEvent(null);
      }}
      className="w-full px-4 py-2 rounded border border-indigo-500/40 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-200 text-sm"
    >
      Install Shady Trader app
    </button>
  );
}
