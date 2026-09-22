// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agentService.svelte', () => ({
  agentService: {
    getById: vi.fn(),
    listThreads: vi.fn(),
    listMessages: vi.fn(),
    createThread: vi.fn(),
  },
}));

vi.mock('../../components', async () => ({
  Button: (await import('../../components/base/Button.svelte')).default,
  IconButton: (await import('../../components/base/IconButton.svelte')).default,
}));

vi.mock('../../services/log/logService', () => ({
  logService: { warn: vi.fn() },
}));

vi.mock('../../components/base/Modal.logic', () => ({
  isAnyModalOpen: vi.fn(() => false),
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'macos'),
}));

vi.mock('../../services/feedback/feedbackService.svelte', () => ({
  feedbackService: { report: vi.fn() },
}));

vi.mock('../../lib/ipc/commands', () => ({
  agentsBackfillThreadTitles: vi.fn(),
  replaceDynamicCommandsBuiltin: vi.fn(),
  showSettingsWindow: vi.fn(),
}));

vi.mock('../../utils/copyText', () => ({ copyText: vi.fn() }));
import { copyText } from '../../utils/copyText';

import AgentChatView from './AgentChatView.svelte';
import { agentService } from './agentService.svelte';
import { agentsManager } from './agentsManager.svelte';
import type { MessageDef } from './types';
import { isAnyModalOpen } from '../../components/base/Modal.logic';
import { platform } from '@tauri-apps/plugin-os';

const mockedAgentService = vi.mocked(agentService);
const mockedPlatform = vi.mocked(platform);

const agent = {
  id: 'agent-1',
  name: 'Asyar Assistant',
  description: null,
  systemPrompt: '',
  providerId: 'provider-1',
  modelId: 'model-1',
  toolSelection: [],
  silent: false,
  inputSource: 'argument' as const,
  outputAction: 'replaceSelection' as const,
  createdAt: 1,
  updatedAt: 1,
};

const thread = {
  id: 'thread-1',
  agentId: agent.id,
  title: 'Thread to delete',
  createdAt: 1,
  updatedAt: 1,
};

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('AgentChatView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAgentService.getById.mockReturnValue(agent);
    mockedAgentService.listThreads.mockResolvedValue([thread]);
    mockedAgentService.listMessages.mockResolvedValue([]);
    mockedPlatform.mockReturnValue('macos');
    vi.mocked(isAnyModalOpen).mockReturnValue(false);
    agentsManager.currentAgentId = agent.id;
    agentsManager.currentThreadId = thread.id;
    agentsManager.sending = false;
    agentsManager.lastAssistantMessageText = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers keyboard-accessible whole-message copy and preserves native copy', async () => {
    const text = '**Answer**\n\n```ts\nconst n = 1;\n```';
    mockedAgentService.listMessages.mockResolvedValue([
      {
        id: 'answer',
        threadId: thread.id,
        role: 'assistant',
        content: { text },
        createdAt: 1,
        runId: null,
      },
    ]);
    render(AgentChatView);
    const button = await screen.findByRole('button', { name: 'Copy message' });
    expect(button.tabIndex).toBe(0);
    expect(button.closest('[data-no-focus-steal]')).not.toBeNull();
    await fireEvent.click(button);
    expect(copyText).toHaveBeenCalledWith(text);
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    const selectionEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(selectionEvent);
    expect(selectionEvent.defaultPrevented).toBe(false);
  });

  it('refreshes the sidebar when the selected thread is cleared after deletion', async () => {
    render(AgentChatView);
    await screen.findByText(thread.title);

    mockedAgentService.listThreads.mockResolvedValue([]);
    agentsManager.currentThreadId = null;

    await screen.findByText('No threads');
    await waitFor(() => expect(screen.queryByText(thread.title)).toBeNull());
  });

  it('fetches the initial thread list only once', async () => {
    render(AgentChatView);

    await screen.findByText(thread.title);
    expect(mockedAgentService.listThreads.mock.calls).toHaveLength(1);
  });

  it.each([
    { hostPlatform: 'macos', shortcut: { metaKey: true }, wrongShortcut: { ctrlKey: true } },
    { hostPlatform: 'windows', shortcut: { ctrlKey: true }, wrongShortcut: { metaKey: true } },
    { hostPlatform: 'linux', shortcut: { ctrlKey: true }, wrongShortcut: { metaKey: true } },
  ])(
    'creates and selects a new thread only with the correct platform shortcut',
    async ({ hostPlatform, shortcut, wrongShortcut }) => {
      const newThread = { ...thread, id: 'thread-new', title: null };
      mockedPlatform.mockReturnValue(hostPlatform as ReturnType<typeof platform>);
      mockedAgentService.createThread.mockResolvedValue(newThread);
      render(AgentChatView);
      await screen.findByText(thread.title);

      const wrongEvent = new KeyboardEvent('keydown', {
        key: 'n',
        ...wrongShortcut,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(wrongEvent);
      expect(mockedAgentService.createThread).not.toHaveBeenCalled();
      expect(wrongEvent.defaultPrevented).toBe(false);

      const event = new KeyboardEvent('keydown', {
        key: 'n',
        ...shortcut,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      await waitFor(() => {
        expect(mockedAgentService.createThread).toHaveBeenCalledWith(agent.id, '');
        expect(agentsManager.currentThreadId).toBe(newThread.id);
      });
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it.each(['modal', 'action panel'] as const)(
    'leaves the new-thread shortcut for an open %s',
    async (overlay) => {
      render(AgentChatView);
      await screen.findByText(thread.title);
      const popup = document.createElement('div');
      if (overlay === 'modal') {
        vi.mocked(isAnyModalOpen).mockReturnValue(true);
      } else {
        popup.className = 'action-popup';
        document.body.appendChild(popup);
      }

      const event = new KeyboardEvent('keydown', {
        key: 'n',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(mockedAgentService.createThread).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      popup.remove();
    },
  );

  it('does not select the new thread after switching to another agent', async () => {
    const newThread = { ...thread, id: 'thread-new', title: null };
    const creation = deferred<typeof newThread>();
    mockedAgentService.createThread.mockReturnValue(creation.promise);
    render(AgentChatView);
    await screen.findByText(thread.title);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(mockedAgentService.createThread).toHaveBeenCalledWith(agent.id, ''));

    agentsManager.currentAgentId = 'agent-2';
    agentsManager.currentThreadId = 'agent-2-thread';
    creation.resolve(newThread);

    await Promise.resolve();
    await Promise.resolve();
    expect(agentsManager.currentThreadId).toBe('agent-2-thread');
  });

  it('ignores messages that resolve after a newer thread is selected', async () => {
    const otherThread = { ...thread, id: 'thread-2', title: 'Current thread' };
    const staleMessages = deferred<MessageDef[]>();
    mockedAgentService.listThreads.mockResolvedValue([thread, otherThread]);
    mockedAgentService.listMessages.mockImplementation((threadId) => {
      if (threadId === thread.id) return staleMessages.promise;
      return Promise.resolve([
        {
          id: 'message-2',
          threadId: otherThread.id,
          role: 'user',
          content: { text: 'Current message' },
          createdAt: 2,
          runId: null,
        },
      ]);
    });

    render(AgentChatView);
    await waitFor(() =>
      expect(mockedAgentService.listMessages.mock.calls).toContainEqual([thread.id]),
    );

    agentsManager.currentThreadId = otherThread.id;
    await screen.findByText('Current message');

    staleMessages.resolve([
      {
        id: 'message-1',
        threadId: thread.id,
        role: 'user',
        content: { text: 'Stale message' },
        createdAt: 1,
        runId: null,
      },
    ]);

    await waitFor(() => expect(screen.queryByText('Stale message')).toBeNull());
    expect(screen.getByText('Current message')).toBeTruthy();
  });

  it('mirrors the latest assistant message onto agentsManager for copy-last-response', async () => {
    mockedAgentService.listMessages.mockResolvedValue([
      {
        id: 'm1',
        threadId: thread.id,
        role: 'user',
        content: { text: 'Hi' },
        createdAt: 1,
        runId: null,
      },
      {
        id: 'm2',
        threadId: thread.id,
        role: 'assistant',
        content: { text: 'Hello there' },
        createdAt: 2,
        runId: null,
      },
    ]);

    render(AgentChatView);
    await screen.findByText(thread.title);

    await waitFor(() => expect(agentsManager.lastAssistantMessageText).toBe('Hello there'));
  });

  it('clears the mirrored assistant text once the thread is cleared', async () => {
    mockedAgentService.listMessages.mockResolvedValue([
      {
        id: 'm2',
        threadId: thread.id,
        role: 'assistant',
        content: { text: 'Hello there' },
        createdAt: 2,
        runId: null,
      },
    ]);
    render(AgentChatView);
    await waitFor(() => expect(agentsManager.lastAssistantMessageText).toBe('Hello there'));

    mockedAgentService.listThreads.mockResolvedValue([]);
    agentsManager.currentThreadId = null;

    await waitFor(() => expect(agentsManager.lastAssistantMessageText).toBeNull());
  });

  it('keeps pending scroll callbacks safe after unmount', async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
    );

    const view = render(AgentChatView);
    await screen.findByText(thread.title);
    view.unmount();

    expect(callbacks.length).toBeGreaterThan(0);
    expect(() => callbacks.forEach((callback) => callback(0))).not.toThrow();
  });
});
