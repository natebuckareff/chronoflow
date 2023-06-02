import { Signal, SignalType } from './signal.js';
import type { ProcessTemplate } from './template.js';
import { Transition } from './transition.js';

export type ProcessGenerator<In, Out, Ret> = Generator<
    undefined,
    Ret | Transition<In, Out, any[], Ret>,
    ProcessYieldResult
>;

export interface ProcessYieldResult {
    readonly ProcessYieldResult: unique symbol;
}

export interface ProcessFn<In, Out, Args extends any[], Ret> {
    (self: ProcessParams<In, Out>, ...args: Args): ProcessGenerator<In, Out, Ret>;
}

export interface ProcessProps<In, Out> {
    get pid(): ProcessID;
    get status(): ProcessStatus;
    get stopped(): boolean;
    get seq(): number;
    get parentSeq(): number | undefined;
    get inboxSize(): number;
    get outboxSize(): number;
    get children(): readonly ChildProcess<In, Out, unknown[]>[];
}

export interface ProcessParams<In, Out> extends ProcessProps<In, Out> {
    In: In;
    Out: Out;
    spawn<CArgs extends any[], CRet>(
        template: ProcessTemplate<In, Out, CArgs, CRet>,
        ...args: CArgs
    ): ChildProcess<In, Out, CRet>;
    joinAll(...children: ChildProcess<In, Out, unknown>[]): ProcessGenerator<In, Out, void>;
    select(where: (incoming: In) => boolean): void;
    filter(where: (incoming: In) => boolean): void;
    receive(_: ProcessYieldResult): In;
    send(outgoing: Out): void;
    use<Args extends any[], R>(fn: (...args: Args) => Promise<R>, ...args: Args): UseResult<R>;
}

export interface UseResult<R> {
    await(_: ProcessYieldResult): R;
}

export interface ChildProcess<In, Out, Ret> extends ProcessProps<In, Out> {
    join(): ProcessGenerator<In, Out, Ret>;
    exit(): [In[], Ret];
}

export type ProcessID = number;

export enum ProcessStatus {
    INITIALIZING,
    RUNNING,
    WAITING,
    JOINING,
    STOPPED,
}

export const ProcessStatusMap: Record<ProcessStatus, string> = {
    [ProcessStatus.INITIALIZING]: 'INITIALIZING',
    [ProcessStatus.RUNNING]: 'RUNNING',
    [ProcessStatus.WAITING]: 'WAITING',
    [ProcessStatus.JOINING]: 'JOINING',
    [ProcessStatus.STOPPED]: 'STOPPED',
};

export type ProcessAny = Process<any, any, any, any>;

export class Process<In, Out, Args extends any[], Ret> {
    private _status?: ProcessStatus;
    private _parent: Process<In, any, any, any> | undefined;
    private _parentSeq: number | undefined;
    private _seq: number;
    private _generator: ProcessGenerator<In, Out, Ret>;
    private _inbox: In[];
    private _outbox: Signal<In, Out>[];
    private _children: Process<In, any, any, any>[];
    private _select: ((incoming: In) => boolean) | undefined;
    private _filter: ((incoming: In) => boolean) | undefined;
    private _awaiting?: Awaiting;
    private _awaiter?: { await(_: ProcessYieldResult): any };
    private _result?: Ret;
    private _replay: ReplayState<In, Out> | undefined;

    constructor(
        public readonly pid: ProcessID,
        parent: Process<In, Out, unknown[], unknown> | undefined,
        func: ProcessFn<In, Out, Args, Ret>,
        ...args: Args
    ) {
        this._parent = parent;
        this._parentSeq = parent?.seq;
        this._seq = 0;
        this._generator = func(this as unknown as ProcessParams<In, Out>, ...args);
        this._inbox = [];
        this._outbox = parent?._outbox ?? [];
        this._children = [];
    }

    replay(replay: Replay<In, Out>): void {
        if (this._status !== undefined) {
            throw Error('cannot replay process');
        }

        this._replay = { ...replay, map: new Map() };

        this.start();
    }

    private _nextReplayedSignal(pid: ProcessID): Signal<In, Out> | undefined {
        const { _replay } = this;

        if (_replay === undefined) {
            return;
        }

        let iter = _replay.map.get(pid);
        if (iter === undefined) {
            iter = _replay.read(pid);
            _replay.map.set(pid, iter);
        }

        const next = iter.next();

        if (next === undefined || next.done === true) {
            return;
        } else {
            return next.value;
        }
    }

    private _applySignal(signal: Signal<In, Out>): void {
        const { pid, _replay, _outbox } = this;

        if (_replay !== undefined) {
            const replayedSignal = this._nextReplayedSignal(pid);

            if (replayedSignal === undefined) {
                this._replay = undefined;
            } else {
                if (signal.pid !== replayedSignal.pid) {
                    throw Error('determinism violation');
                }

                if (signal.type !== replayedSignal.type) {
                    throw Error('determinism violation');
                }

                // XXX: include sequence numbers
                // if (signal.data)
            }
        }

        _outbox.push(signal);
    }

    start(): void {
        if (this._status !== undefined) {
            throw Error('already started');
        }

        const { pid, _outbox, _replay } = this;

        const signal: Signal.Start = {
            pid,
            type: SignalType.START,
        };

        if (_replay !== undefined) {
            const replayedSignal = this._nextReplayedSignal(pid);

            if (replayedSignal === undefined) {
                this._replay = undefined;
            } else {
                if (signal.pid !== replayedSignal.pid) {
                    throw Error('determinism violation');
                }

                if (signal.type !== replayedSignal.type) {
                    throw Error('determinism violation');
                }

                const fastForward = _replay.handler(signal);

                if (fastForward !== undefined) {
                    while (true) {
                        const nextSignal = this._nextReplayedSignal(pid);

                        // NOTE: The caller can notice that some incoming
                        // messages will be DROP'ed by all processes except the
                        // one that they intend to fast-forward. In that case,
                        // the caller does not need to push

                        if (nextSignal === undefined) {
                            throw Error('failed to fast-forward');
                        }

                        if (nextSignal.pid !== pid) {
                            throw Error('determinism violation');
                        }

                        // TODO: This would need some help from the caller to
                        // provide the template to spawn the child. All we have
                        // here is the child PID. That needs to be mapped to a
                        // template somehow. Then, when we see a corresponding
                        // JOIN signal, just run the join logic on the child

                        if (nextSignal.type === SignalType.SPAWN) {
                            throw Error('not implemented; nested fast-forward');
                        }

                        if (nextSignal.type === SignalType.STOP) {
                            this._stop(fastForward as Ret);
                            break;
                        }

                        _outbox.push(nextSignal);
                    }

                    return;
                }
            }
        }

        this._status = ProcessStatus.INITIALIZING;

        _outbox.push(signal);
    }

    get status(): ProcessStatus {
        if (this._status === undefined) {
            throw Error('not started');
        }
        return this._status;
    }

    get started(): boolean {
        return this._status !== undefined;
    }

    get stopped(): boolean {
        return this._status === ProcessStatus.STOPPED;
    }

    get seq(): number {
        return this._seq;
    }

    get parentSeq(): number | undefined {
        return this._parentSeq;
    }

    get inboxSize(): number {
        return this._inbox.length;
    }

    get outboxSize(): number {
        return this._inbox.length;
    }

    get children(): readonly ChildProcess<In, Out, unknown[]>[] {
        return this._children;
    }

    pushAsync(incoming: In): void {
        this._push(incoming);
    }

    async wait(): Promise<void> {
        if (this._generator === undefined) {
            throw Error('process not started');
        }

        const { _awaiting } = this;

        if (_awaiting?.active && _awaiting.pending) {
            await _awaiting.promise;
        }
    }

    async update(): Promise<void> {
        await this.wait();
        this._update();
    }

    updateAsync(): void {
        if (this._generator === undefined) {
            throw Error('process not started');
        }

        this._update();
    }

    async push(incoming: In): Promise<void> {
        await this.wait();
        this._push(incoming);
        this._update();
    }

    *pull(limit?: number): Iterable<Signal<In, Out>> {
        const { _outbox } = this;
        let count = 0;
        while (_outbox.length > 0) {
            if (limit !== undefined && count >= limit) {
                break;
            }
            yield _outbox.shift()!;
            count += 1;
        }
    }

    private _push(incoming: In): void {
        if (this.stopped) {
            throw Error('process not running');
        }

        let { pid, _inbox, _select, _filter } = this;

        if (_inbox.length > 50 /* TODO: limits policy */) {
            this._applySignal({ pid, type: SignalType.BACKOFF });
        }

        if (_select !== undefined) {
            if (_select(incoming)) {
                _inbox.unshift(incoming);
                this._select = undefined;
            } else {
                _inbox.push(incoming);
            }
        } else if (_filter !== undefined) {
            if (_filter(incoming)) {
                _inbox.push(incoming);
                this._filter = undefined;
            } else {
                this._applySignal({ pid, type: SignalType.DROP, data: incoming });
            }
        } else {
            _inbox.push(incoming);
        }

        for (const child of this._children) {
            if (!child.stopped) {
                child._push(incoming);
            }
        }
    }

    // XXX
    get blocked(): boolean {
        if (!this._awaiting?.active && this._status === ProcessStatus.RUNNING) {
            // waiting for incoming
            if (this._select !== undefined || this._inbox.length === 0) {
                return true;
            }
        }

        // Waiting for promise to resolve
        if (this._awaiting?.active && this._awaiting.pending) {
            return true;
        }

        return false;
    }

    private _update(): void {
        while (true) {
            if (!this._awaiting?.active && this._status === ProcessStatus.RUNNING) {
                // waiting for incoming
                if (this._select !== undefined || this._inbox.length === 0) {
                    return;
                }
            }

            // Waiting for promise to resolve
            if (this._awaiting?.active && this._awaiting.pending) {
                return;
            }

            if (this._status === ProcessStatus.STOPPED) {
                throw Error('process not running');
            }

            // INITIALIZING                     -> first run
            // RECEIVING && _inbox.length > 0   -> `receive(yield)`
            // JOINING                          -> children will process
            // PROMISE_USED                     -> promise resolved

            const result = this._generator!.next();

            for (const child of this._children) {
                if (!child.stopped) {
                    child._update();
                }
            }

            if (result.done === true) {
                const { value } = result;
                if (value instanceof Transition) {
                    this._transition(value);
                } else {
                    this._stop(value);
                    return;
                }
            }

            if (this._status === ProcessStatus.INITIALIZING) {
                this._status = ProcessStatus.RUNNING;
            }

            if (this._status === ProcessStatus.RUNNING) {
                // `receive` will be called

                if (this._inbox.length > 0) {
                    // If the inbox is not empty, loop so `receive` can be
                    // called
                    continue;
                }

                // Return so caller can push messages
                return;
            }

            if (this._status === ProcessStatus.JOINING) {
                // `join` was called. Return control to caller to allow messages
                // to be pushed to children
                return;
            }
        }
    }

    private _transition(transition: Transition<In, Out, any[], Ret>): void {
        if (this._awaiting?.active) {
            throw Error('promise not awaited');
        }

        this._generator = transition.target.config.entrypoint(this as any, ...transition.args);

        this._applySignal({ pid: this.pid, type: SignalType.TRANSITION, transition });
    }

    private _stop(result: Ret): void {
        if (this._awaiting?.active) {
            throw Error('promise not awaited');
        }

        if (this._children.length > 0) {
            throw Error('children not joined');
        }

        this._status = ProcessStatus.STOPPED;
        this._result = result;

        this._applySignal({ pid: this.pid, type: SignalType.STOP });
    }

    spawn<CArgs extends any[], CRet>(
        template: ProcessTemplate<In, Out, CArgs, CRet>,
        ...args: CArgs
    ): Process<In, Out, CArgs, CRet> {
        const { pid, _replay } = this;

        let childPid: ProcessID;

        const replayedSignal = this._nextReplayedSignal(pid);

        if (_replay !== undefined && replayedSignal === undefined) {
            this._replay = undefined;
        }

        if (replayedSignal !== undefined) {
            if (replayedSignal.type !== SignalType.SPAWN) {
                throw Error('determinism violation');
            }

            childPid = replayedSignal.child;
        } else {
            childPid = (pid + 1) as ProcessID; // XXX
        }

        const { entrypoint } = template.config;
        const child = new Process<In, Out, CArgs, CRet>(childPid, this, entrypoint, ...args);

        child._inbox.push(...(this._inbox as any));

        this._children.push(child);
        this._outbox.push({ pid, type: SignalType.SPAWN, child: childPid });

        if (_replay !== undefined) {
            child.replay(_replay);
        } else {
            child.start();
        }

        return child;
    }

    *join(): ProcessGenerator<In, Out, Ret> {
        const { _parent } = this;

        if (_parent === undefined) {
            throw Error('cannot join root');
        }

        _parent._status = ProcessStatus.JOINING;
        _parent._applySignal({ pid: _parent.pid, type: SignalType.JOIN, child: this.pid });

        while (!this.stopped) {
            yield;
        }

        _parent._status = ProcessStatus.RUNNING;

        const { _children } = _parent;
        const i = _children.indexOf(this);
        if (i === -1) {
            throw Error('child not found');
        }
        _children.splice(i, 1);

        return this._result!;
    }

    *joinAll(...children: ProcessAny[]): ProcessGenerator<In, Out, void> {
        this._status = ProcessStatus.JOINING;

        const { _children } = this;

        this._status = ProcessStatus.JOINING;

        for (const child of children) {
            const { _parent } = child;

            if (_parent === undefined) {
                throw Error('cannot join root');
            }

            if (_parent !== this) {
                throw Error('joiner not parent of joinee');
            }

            while (!child.stopped) {
                yield;
            }

            const i = _children.indexOf(child);
            if (i === -1) {
                throw Error('child not found');
            }
            _children.splice(i, 1);
        }

        this._status = ProcessStatus.RUNNING;
    }

    select(where: (incoming: In) => boolean): void {
        if (this._select !== undefined) {
            throw Error('selector already set');
        }

        if (this._filter !== undefined) {
            throw Error('filter already set');
        }

        const { _inbox } = this;

        // Check if the selector matches any messages already in the inbox
        for (let i = 0; i < _inbox.length; ++i) {
            const incoming = _inbox[i]!;
            if (where(incoming)) {
                _inbox.splice(i, 1);
                _inbox.unshift(incoming);
                return;
            }
        }

        // Selector will be used when pushing new messages to the inbox
        this._select = where;
    }

    filter(where: (incoming: In) => boolean): void {
        if (this._select !== undefined) {
            throw Error('selector already set');
        }

        if (this._filter !== undefined) {
            throw Error('filter already set');
        }

        const { _inbox } = this;

        // Filter the inbox until a match is found
        while (_inbox.length > 0) {
            const incoming = _inbox[0]!;

            if (where(incoming)) {
                return;
            }

            _inbox.shift();

            this._applySignal({ pid: this.pid, type: SignalType.DROP, data: incoming });
        }

        // If not match is found, filter will be used when pushing new messages
        // to the inbox
        this._filter = where;
    }

    receive(_: ProcessYieldResult): In {
        if (this._status !== ProcessStatus.RUNNING) {
            throw Error('cannot receive');
        }

        if (this._awaiting?.active) {
            throw Error('promise pending');
        }

        if (this._inbox.length === 0) {
            throw Error('inbox empty');
        }

        const incoming = this._inbox.shift()!;

        this._seq += 1;

        return incoming;
    }

    send(outgoing: Out): void {
        this._applySignal({ pid: this.pid, type: SignalType.SEND, data: outgoing });
        this._seq += 1;
    }

    use<Args extends any[], R>(fn: (...args: Args) => Promise<R>, ...args: Args): UseResult<R> {
        if (this._awaiting?.active) {
            throw Error('promise already pending');
        }

        switch (this._status) {
            case ProcessStatus.INITIALIZING:
            case ProcessStatus.RUNNING:
                break;

            default:
                throw Error('cannot use promise');
        }

        const signal: Signal.Use = {
            pid: this.pid,
            type: SignalType.USE,
        };

        this._awaiting ??= { active: true, promise: undefined!, pending: true };

        const _awaiting = this._awaiting as AwaitingActive;

        const { _replay } = this;

        const cachedResult = _replay && _replay.handler(signal);

        if (cachedResult === undefined) {
            _awaiting.active = true;
            _awaiting.pending = true;

            const promise = fn(...args);

            _awaiting.promise = promise.then(result => {
                if (!_awaiting.active) {
                    throw Error('invalid promise state when resolving');
                }
                _awaiting.result = result;
                _awaiting.pending = false;
            });
        } else {
            _awaiting.active = true;
            _awaiting.pending = false;
            _awaiting.result = cachedResult;
        }

        this._applySignal(signal);

        this._awaiter ??= {
            await(_) {
                if (!_awaiting.active) {
                    throw Error('invalid promise state when awaiting');
                }
                (_awaiting as any).active = false;
                return _awaiting.result;
            },
        };

        return this._awaiter;
    }

    exit(): [In[], Ret] {
        if (!this.stopped) {
            throw Error('process is busy');
        }
        return [this._inbox, this._result!];
    }
}

type Awaiting = AwaitingInactive | AwaitingActive;

interface AwaitingInactive {
    active: false;
}

interface AwaitingActive {
    active: true;
    promise: Promise<void>;
    pending: boolean;
    result?: any;
}

interface Replay<In, Out> {
    read: (pid: ProcessID) => IterableIterator<Signal<In, Out>>;
    handler: ReplayHandler;
}

interface ReplayState<In, Out> extends Replay<In, Out> {
    map: Map<ProcessID, IterableIterator<Signal<In, Out>>>;
}

interface ReplayHandler {
    (signal: Signal.Start): unknown | undefined; // !undefined -> fast-forward
    (signal: Signal.Use): unknown; // cached result
}
