import { create } from 'zustand';

interface ConnectionState {
  isDataPassing: boolean;
  lastCallTime: number;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  lastConnectedTime: number;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  setDataPassing: (passing: boolean) => void;
  updateLastCallTime: (time: number) => void;
  setConnectionStatus: (status: 'connecting' | 'connected' | 'disconnected') => void;
  setLastConnectedTime: (time: number) => void;
  incrementReconnectAttempts: () => void;
  resetReconnectAttempts: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  isDataPassing: false,
  lastCallTime: 0,
  connectionStatus: 'connecting',
  lastConnectedTime: 0,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,

  setDataPassing: (passing) => set({ isDataPassing: passing }),

  updateLastCallTime: (time) => set({ lastCallTime: time }),

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  setLastConnectedTime: (time) => set({ lastConnectedTime: time }),

  incrementReconnectAttempts: () => set((state) => ({
    reconnectAttempts: state.reconnectAttempts + 1
  })),

  resetReconnectAttempts: () => set({ reconnectAttempts: 0 }),
}));

// Centralized API call tracking
export const trackApiCall = () => {
  const store = useConnectionStore.getState();
  store.updateLastCallTime(Date.now());
  store.setDataPassing(true);
};