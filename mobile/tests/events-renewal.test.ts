import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { ApiError, type StaffEvent } from '../src/api.ts';

// Execute the actual screen callbacks with deterministic hook scheduling and native component stubs.
// This checks render state and effect cleanup, not a device's rendering or navigation implementation.
type Node = { type: string; props: Record<string, unknown> };
type Hook = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
const code = ts.transpileModule(readFileSync(new URL('../src/app/events.tsx', import.meta.url), 'utf8')
  + '\nexport { EventsList };', { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const event: StaffEvent = { id: 7, title: 'Fair', date: '2030-05-01T12:00:00Z', location: 'Hall' };
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const hooks: Hook[] = [];
  let slot = 0;
  let effects: (() => void)[] = [];
  const requests: { token: string; resolve: (data: StaffEvent[]) => void; reject: (error: unknown) => void }[] = [];
  const destinations: unknown[] = [];
  const next = () => hooks[slot++] ?? (hooks[slot - 1] = {});
  const jsx = (type: string, props: Record<string, unknown>): Node => ({ type, props });
  const api = { events: (token: string) => new Promise<StaffEvent[]>((resolve, reject) => {
    requests.push({ token, resolve, reject });
  }) };
  const session = { setSession: () => {}, renew: async () => 'unavailable' };
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const hook = next();
        if (!('value' in hook)) hook.value = typeof initial === 'function' ? initial() : initial;
        return [hook.value, (value: unknown) => { hook.value = typeof value === 'function' ? value(hook.value) : value; }];
      },
      useEffect(effect: () => (() => void), deps: unknown[]) {
        const hook = next();
        if (hook.deps && deps.every((value, i) => Object.is(value, hook.deps![i]))) return;
        hook.deps = deps;
        effects.push(() => { hook.cleanup?.(); hook.cleanup = effect(); });
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...Object.fromEntries(['ActivityIndicator', 'Button', 'FlatList', 'Pressable', 'Text', 'View'].map(x => [x, x])),
      StyleSheet: { create: (styles: unknown) => styles } },
    'expo-router': { router: { push: (target: unknown) => destinations.push(target) } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '../api': { api, ApiError }, '../session': { useSession: () => session },
    '../attendance': { useUndoStore: () => ({ pending: () => [] }) },
    '../language': { useLanguage: () => ({ copy: {}, locale: 'ru' }) },
    '../messages': { errorMessage: () => 'error', localeTag: () => 'ru-RU' },
  };
  const exports = {} as { EventsList: (props: { token: string; userId: number }) => Node };
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in modules, name);
    return modules[name];
  }, exports);
  return {
    requests, destinations,
    render(token: string) {
      slot = 0;
      const tree = exports.EventsList({ token, userId: 42 });
      const pending = effects;
      effects = [];
      pending.forEach(effect => effect());
      return tree;
    },
  };
}

function list(tree: Node): Node {
  return (tree.props.children as Node[]).find(node => node?.type === 'FlatList')!;
}

test('renewing the token hides old events until the new request settles, including a removed assignment', async () => {
  const screen = harness();
  screen.render('old-token');
  screen.requests[0].resolve([event]);
  await flush();
  assert.deepEqual(list(screen.render('old-token')).props.data, [event]);
  const loading = screen.render('new-token');
  assert.deepEqual(list(loading).props.data, [], 'old assignments must not remain selectable during renewal reload');
  assert.equal(screen.requests[1].token, 'new-token');
  screen.requests[1].resolve([]);
  await flush();
  assert.deepEqual(list(screen.render('new-token')).props.data, []);
  assert.deepEqual(screen.destinations, []);
});

test('an old event response cannot repopulate the list after the renewed request fails', async () => {
  const screen = harness();
  screen.render('old-token');
  screen.render('new-token');
  screen.requests[1].reject(new ApiError('FORBIDDEN', 'assignment revoked', 403));
  await flush();
  screen.requests[0].resolve([event]);
  await flush();
  assert.deepEqual(list(screen.render('new-token')).props.data, []);
});
