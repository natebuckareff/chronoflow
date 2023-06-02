import type { ProcessTemplate } from './template';

// TODO: `In`, `Out`, and `Ret` must be the same. `Args` can be different for
// the target process

export type TransitionUnknown = Transition<unknown, unknown, unknown[], unknown>;

export class Transition<In, Out, Args extends any[], Ret> {
    private _target: ProcessTemplate<In, Out, Args, Ret>;
    private _args: Args;

    constructor(target: ProcessTemplate<In, Out, Args, Ret>, ...args: Args) {
        this._target = target;
        this._args = args;
    }

    get target(): ProcessTemplate<In, Out, Args, Ret> {
        return this._target;
    }

    get args(): Args {
        return this._args;
    }
}
