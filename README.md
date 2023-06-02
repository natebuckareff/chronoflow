# Chronoflow

Message passing processes for TypeScript.

## Motivation

> 🚧 This library is experimental and being actively worked. Expect it to change.

Chronoflow is a runtime for scheduling Erlang-style message passing processes in TypeScript. The original use case was a lightweight alternative to [Temporal.io](https://temporal.io/) for single-node applications.

## Inspiration

- [Erlang][1]
- [Temporal.io][2]
- [Event Sourcing][3]
- State machines and [statecharts][4]
- [Replicated state machines][5]
- [AWS Step Functions][6]
- [The Reactive Manifesto][7]

[1]: https://learnyousomeerlang.com/introduction#what-is-erlang
[2]: https://www.temporal.io/blog/workflow-engine-principles
[3]: https://martinfowler.com/articles/lmax.html
[4]: https://www.sciencedirect.com/science/article/pii/0167642387900359/pdf
[5]: https://signalsandthreads.com/state-machine-replication-and-why-you-should-care/
[6]: https://docs.aws.amazon.com/managedservices/latest/userguide/step.html
[7]: https://www.reactivemanifesto.org/

## Todo

- [x] Inbox lookahead matching and filtering
- [x] Process signals
- [x] Promises without async generators
- [x] Nested child processes
- [x] Basic event replay
- [x] Fast-forwarded replay
- [ ] Tail recursion using transitions
- [ ] Transition state snapshotting
- [ ] Infer return type for `receive` from select/filter
- [ ] Template metadata
- [ ] Dispatching
- [ ] Error signals and process supervisors
- [ ] Limits policy, retries, and timeouts

## Install

```
pnpm install chronoflow
```

## Getting Started

Use the `template` function to define a new process template. It takes a `ProcessParams` type argument which defines the types of received and sent messages.

The `template` function returns a callback (enabling types to be inferred) which takes a `ProcessConfig` object. There are only two config properties: `route` which is optional and `entrypoint` which is the process generator function.

> When defined, the `route` callback tells [`SimpleScheduler`](#the-simplescheduler) the destination process ID of sent messages.

```ts
const Greeter = template<ProcessParams<string, string>>()({
    *entrypoint(self, count: number) {
        for (let i = 0; i < count; ++i) {
            const name = self.receive(yield);

            console.log('received', name);

            self.send(`greeting #${i}: Hello ${name}!`);
        }
    },
});
```

Once you've defined your process instantiate it by calling the `create()` method on the process template.

```ts
const proc = Greeter.create(0, 10); 
```

The new process isn't started yet so we'll get an error if we try using it. To start the process call the `start()` method:

```ts
proc.start();
```

> If [replaying](#replaying-signals) the process using signals we saved from a previous run, we'd call `replay()` instead of `start()`.

Now we can interact with the generator function defined in the template. To push a message to the process's inbox and let it run call `push()`.

```ts
await proc.push('Alice');
```

We'll see `"received Alice"` printed to the console, but not the response. To read back the response call `pull()`.

```ts
for (const signal of proc.pull()) {
    console.log(signal);
}
```

Now in the console we'll see:

```
{ pid: 0, type: 0 }
{ pid: 0, type: 5, data: 'greeting #0: Hello Alice!' }
```

These objects are called [`Signals`](#signals). They represent not just messages sent by calling `send()`, but also other process events such as when the process first starts running, when it finished, and others. The first signal object with `type: 0`  is the `START` signal and the second one with `type: 5` is the `SEND` signal, along with our message in the `data` property.

## The `SimpleScheduler`

The process template `create()` method is great for quickly starting up a process. But it has drawbacks. For one, we have to pick a process ID and there's nothing preventing us from assigning the same ID to different processes. And if we have multiple processes and want them to send messagess to each other, we need to manually orchestrate that by calling `push()` and `pull()`.

The `SimpleScheduler` solves those issues by spawning process instances for us and automatically routing messages between them.

First, let's create a new process template to use with the `SimpleScheduler`.

```ts
interface Message {
    from: number;
    to: number;
    data: string;
}

const Echo = template<ProcessParams<Message, Message>>()({
    route(outgoing) {
        return outgoing.to;
    },
    *entrypoint(self, count: number) {
        for (let i = 0; i < count; ++i) {
            const { from, data } = self.receive(yield);

            console.log(`${self.pid}> i=${i} received ${data} from ${from}`);

            self.send({ from: self.pid, to: from, data });

            self.use(sleep, 1_000).await(yield);
        }
    },
});
```

The `Echo` process waits for a message, sends one back to the sender, and then waits for 1 second. Since process generator functions are not async generators we call `use()` and then `.await(yield)` to wait for the promise to resolve.

> If process generator functions were async then a `Promise` object would be created every time we yeild, even if we're just yielding a non-promise value. In the future, Chronoflow may support async generators, but for now the `use(...).await(yield)` pattern is the only way to resolve a promise from within a process.

Next, create a new scheduler and spawn two processes.


```ts
const scheduler = new SimpleScheduler();

const proc1 = scheduler.create(Echo, 5);
const proc2 = scheduler.create(Echo, 5);

proc1.start();
proc2.start();
```

If we ran the processes as they are, nothing will happen since they'll immediately just wait to receive a message forever. So let's spoof a message being sent to one of the new processes and then update the scheduler in a loop.


```ts
proc1.send({ from: proc2.pid, to: proc1.pid, data: 'hello' })

while (true) {
    if (await scheduler.update()) {
        break;
    }
}
```

In the console we'll see that the processes are running and receiving messages from each other.

```
0> i=0 received hello from 1
1> i=0 received hello from 0
0> i=1 received hello from 1
1> i=1 received hello from 0
0> i=2 received hello from 1
1> i=2 received hello from 0
0> i=3 received hello from 1
1> i=3 received hello from 0
0> i=4 received hello from 1
1> i=4 received hello from 0
```

## Selecting and Filtering Messages

`select()` waits until the process receives a message that matches the predicate function. Any non-matching messages received while waiting are pushed to the inbox.

`filter()` also waits until the process receives a message matching the predicate, but any messages received that don't match are dropped. The `DROP` signal is emitted for each dropped message.

```ts
interface ServerReq {
    id: number
    from: number;
    to: number;
    command: string
}

interface ServerRes {
    id: number
    from: number
    to: number
    result: any
}
```

```ts
const Server = template<ProcessParams<Request, Response>>()({
    route(outgoing) {
        return outgoing.to;
    },
    *entrypoint(self) {
        while (true) {
            const req = self.receive(yield);

            let result: any;

            if (req.command === 'TIME') {
                result = Date.now();
            } else {
                result = 'error'
            }

            const { id, from } = req;
            self.send({ id, from: self.pid, to: from, result });
        }
    },
});
```

```ts
const Client = template<ProcessParams<ServerRes, ServerReq>>()({
    route(outgoing) {
        return outgoing.to;
    },
    *entrypoint(self, serverPid: number) {
        self.send({ id: 100, from: self.pid, to: serverPid, command: 'TIME' });
        self.send({ id: 101, from: self.pid, to: serverPid, command: 'TIME' });
        self.send({ id: 102, from: self.pid, to: serverPid, command: 'STOP' });

        self.select(incoming => incoming.id === 102);
        console.log(self.receive(yield));

        self.select(incoming => incoming.id === 101);
        console.log(self.receive(yield));

        self.select(incoming => incoming.id === 100);
        console.log(self.receive(yield));
    },
});

```

## Child Processes

```ts
const Parent = template()({
    *entrypoint(self, serverPid: number) {
        const child1 = self.spawn(Child, 'child1');
        const child2 = self.spawn(Child, 'child2');
        const child3 = self.spawn(Child, 'child3');

        console.log('parent', self.receive(yield));
        
        yield* child3.join();
        yield* child2.join();
        yield* child1.join();
    },
});

const Child = template()({
    *entrypoint(self, name: string) {
        for (let i = 0; i < 3; ++i) {
            console.log('child', name, self.receive(yield));
        }
    },
});

const parent = Parent.create(0);

parent.start();

await parent.push('msg1');
await parent.push('msg2');
await parent.push('msg3');
await parent.push('msg4');
```

Child processes will receive all messages that their parent process receives from the moment after they are spawned. If there are unprocessed messages in the parent's inbox when they are spawned, then those will also be received by the child.

Child processes cannot outlive their parent.

## Replaying Signals

> 🚧 This functionality is incomplete.

> ⚠️ Replay only works if your processes are deterministic. Chronoflow will perform checks (using sequence numbers) to catch any unexpected signals during runtime. The rule is: **all side effects should be performed using promises or by sending messages**. Think of your processes are pure functions over their received messages.

TODO:
- [ ] Nested fast-forwarding of child processes

Signals can be written to durable storage and then replayed later to recover a process's runtime state. This is a powerful pattern called [Event Sourcing](https://martinfowler.com/articles/lmax.html) and Chronoflow tries to give you tools to implement it.

To record a process's signals we just call `pull()`. Writing those signals to storage is out-of-scope for Chronoflow. Assuming you've managed to write your signals to storage and can read them back, you can replay the signals by calling `replay()` instead of `start()`.

`replay()` takes a configuration object with a `handler` method and `read` method.

TODO:
- [ ] Rename `handler` and `read` to something more meaningful

The `handler` method is called whenever the process will emit a `START` or `USE` signal.

In the case of `START` the purpose is to check if the process already started and stopped, meaning we may already have the result and all emitted signals saved. In which case: we don't need to re-run the process and can instead just emit all of the saved signals and return the saved result.

In the case of `USE` we can return the previous promise result.

The `read` method is used to pull the saved signals. This is where you would read signals from a file or database and return them as an `IterableIterator`. If the replaying process spawned children, then `read` will be called with the process ID of those children and expect a separate iterator for each process in the replaying process tree.

```ts
const proc = Greeter.create(0, 10); 

proc.replay({
    handler(signal) {
        if (signal.type === SignalType.USE) {
            return getCachedPromise(signal);
        } else {
            return getProcessResult(signal);
        }
    },
    read(pid) {
        return getSignalIteratorForPid(pid);
    },
});
```

Re-send all saved messages to the process which will cause it to pull signals by calling `read()`.

> Any signal that is `DROP`'ed by all processes it is sent to can be safely deleted. Any signal that is only *not* dropped by fast-forwarded processes may also be safely deleted.

When the signal iterator signals that it's done, the process switches to running normally.

## Transitions

> 🚧 This functionality is incomplete.

If you want to durably save a process for later replay, then you have to write all signals ever emitted. And then replay all those signals every single time you replay. This is not optimal.

Transitions help by allowing a process to "rollup" all of its state so far and replace it with a single value. To do this safely, a process creates and then returns a `Transition` object. The object takes a new generator function and its arguments. After returning, the new generator takes over and the process continues.

The process will emit a `TRANSITION` signal before starting the new generator. We only need to save the last `TRANSITION` signal and all signals emitted after to replay process state.

## Signals

| Name         | Description                                            |
| ------------ | ------------------------------------------------------ |
| `START`      | Process has started.                                   |
| `SPAWN`      | Process has spawned a child process.                   |
| `JOIN`       | Process has joined a previously spawned child process. |
| `TRANSITION` | Process returned a `Transition` object.                |
| `USE`        | Process called `use()` on a promise factory.           |
| `SEND`       | Process called `send()`.                               |
| `STOP`       | Process generator is finished.                         |
| `BACKOFF`    | Process inbox is full.                                 |
| `DROP`       | Message was rejected by a filter.                      |
