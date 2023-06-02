import type { ProcessAny, ProcessFn, ProcessID, ProcessParams } from './process';
import { Process } from './process.js';

export interface ProcessConfig<In, Out, Args extends any[], Ret> {
    readonly route?: (outgoing: Out) => ProcessID | void | undefined;
    readonly entrypoint: ProcessFn<In, Out, Args, Ret>;
}

export class ProcessTemplate<In, Out, Args extends any[], Ret> {
    constructor(public readonly config: ProcessConfig<In, Out, Args, Ret>) {}

    create(pid: number, ...args: Args): Process<In, Out, Args, Ret>;
    create(parent: ProcessAny, pid: number, ...args: Args): Process<In, Out, Args, Ret>;
    create(arg1: number | ProcessAny, arg2?: any, ...rest: any[]): ProcessAny {
        let pid: number;
        let parent: ProcessAny | undefined;
        let args: any[];

        if (typeof arg1 === 'number') {
            pid = arg1;
            args = [arg2, ...rest];
        } else {
            parent = arg1 as ProcessAny;
            pid = arg2;
            args = rest;
        }

        return new Process<any, any, any, any>(pid, parent, this.config.entrypoint, ...args);
    }
}

export function template<P extends ProcessParams<any, any>>() {
    return <Args extends any[], Ret>(
        config: ProcessConfig<P['In'], P['Out'], Args, Ret>
    ): ProcessTemplate<P['In'], P['Out'], Args, Ret> => {
        return new ProcessTemplate(config);
    };
}
