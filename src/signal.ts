import type { ProcessID } from './process';
import type { Transition as ProcessTransition } from './transition';

export enum SignalType {
    START,
    SPAWN,
    JOIN,
    TRANSITION,
    USE,
    SEND,
    STOP,
    BACKOFF,
    DROP,
}

// TODO: Do we need a AWAIT/RESOLVE signal?

export const SignalTypeMap: Record<SignalType, string> = {
    [SignalType.START]: 'START',
    [SignalType.SPAWN]: 'SPAWN',
    [SignalType.JOIN]: 'JOIN',
    [SignalType.TRANSITION]: 'TRANSITION',
    [SignalType.USE]: 'USE',
    [SignalType.SEND]: 'SEND',
    [SignalType.STOP]: 'STOP',
    [SignalType.BACKOFF]: 'BACKOFF',
    [SignalType.DROP]: 'DROP',
};

export interface BaseSignal<T extends SignalType> {
    readonly pid: ProcessID;
    readonly type: T;
}

export type Signal<In, Out> =
    | Signal.Start
    | Signal.Spawn
    | Signal.Join
    | Signal.Transition<In, Out>
    | Signal.Use
    | Signal.Send<Out>
    | Signal.Stop
    | Signal.Backoff
    | Signal.Drop<In>;

export namespace Signal {
    export type Start = BaseSignal<SignalType.START>;
    export type Use = BaseSignal<SignalType.USE>;
    export type Stop = BaseSignal<SignalType.STOP>;
    export type Backoff = BaseSignal<SignalType.BACKOFF>;

    export interface Spawn extends BaseSignal<SignalType.SPAWN> {
        child: ProcessID;
    }

    export interface Join extends BaseSignal<SignalType.JOIN> {
        child: ProcessID;
    }

    export interface Transition<In, Out> extends BaseSignal<SignalType.TRANSITION> {
        transition: ProcessTransition<In, Out, unknown[], unknown>;
    }

    export interface Send<Out> extends BaseSignal<SignalType.SEND> {
        data: Out;
    }

    // NOTE: During replay, dropped messages will just be dropped again, so they
    // do not need to be pushed. If a message is dropped by all non
    // fast-forwarded processes, then it can be deleted

    export interface Drop<In> extends BaseSignal<SignalType.DROP> {
        data: In;
    }

    export function print<In, Out>({ pid, type, ...rest }: Signal<In, Out>): void {
        console.log(`SIGNAL(${pid}, ${SignalTypeMap[type]}):`, rest);
    }
}
