import { Process, type ProcessID } from './process.js';
import { SignalType } from './signal.js';
import type { ProcessTemplate } from './template';

export class SimpleScheduler {
    private _procs: Map<ProcessID, RunState>;
    private _runqueue: RunState[];
    private _nextId: number;

    constructor() {
        this._procs = new Map();
        this._runqueue = [];
        this._nextId = 0;
    }

    create<In, Out, Args extends any[], Ret>(
        template: ProcessTemplate<In, Out, Args, Ret>,
        ...args: Args
    ): Process<In, Out, Args, Ret> {
        const pid = this._nextId as unknown as ProcessID;
        const proc = new Process(pid, undefined, template.config.entrypoint, ...args);
        const state: RunState = { template, proc, outbox: [] };
        // proc.start();
        this._nextId += 1;
        this._procs.set(pid, state);
        this._runqueue.push(state);
        return proc;
    }

    pull<In, Out, Args extends any[], Ret>(
        template: ProcessTemplate<In, Out, Args, Ret>,
        pid: ProcessID
    ): Out[] {
        const state = this._procs.get(pid);

        if (state === undefined) {
            throw Error('process not found');
        }

        if (template !== state.template) {
            throw Error('provided template does not match found template');
        }

        const { outbox } = state;

        return outbox.splice(0, outbox.length);
    }

    async update(limit?: number): Promise<boolean> {
        let i = 0;

        let allBlocked = true;

        while (i < this._runqueue.length) {
            const { template, proc, outbox } = this._runqueue[i]!;

            if (!proc.started) {
                i += 1;
                continue;
            }

            if (proc.stopped) {
                this._runqueue.splice(i, 1);
                this._procs.delete(proc.pid);
                continue;
            }

            await proc.wait();

            if (proc.blocked) {
                i += 1;
                continue;
            }

            allBlocked = false;

            proc.updateAsync();

            const { route } = template.config;

            for (const signal of proc.pull(limit)) {
                if (signal.type !== SignalType.SEND) {
                    continue;
                }

                const msg = signal.data;
                const to = route && route(msg);

                if (to !== undefined) {
                    const dest = this._procs.get(to);

                    if (dest) {
                        dest.proc.pushAsync(msg);
                        continue;
                    }
                }

                outbox.push(msg);
            }

            i += 1;
        }

        return allBlocked;
    }
}

interface RunState {
    template: ProcessTemplate<any, any, any, any>;
    proc: Process<any, any, any, any>;
    outbox: any[];
}
