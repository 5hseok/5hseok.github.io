---
layout: post
title: "ECS Deep Dive — Taking Over a Worker Migration and Digging Into ECS Internals From Scratch"
date: 2026-06-25 09:00:00 +0900
categories: [블로그]
tags: [ECS, AWS, Containers, Orchestration, Networking]
mermaid: true
hidden: true
---

# Inheriting an ECS Migration I Didn't Start

After taking some time off for personal reasons, I came back to hear that a teammate had tried migrating from EC2 to ECS, hit a problem, and ended up rolling everything back to EC2. And that work had landed on my desk.

The catch: I'd never really worked with ECS at a production level before, so I wasn't confident. Touching it with only shallow background knowledge would almost certainly make things worse. So before touching any code, I decided to figure out **what ECS actually does under the hood**. In what order does it start a container? How does it keep checking whether one is alive? How does it swap in a new version? If I wanted a migration and deployment that didn't fail, I couldn't just hand-wave past this. So I sat down and went deep on ECS.

> By the way, **why the previous migration failed and how I eventually got it working** is something I'll cover in a separate post.

---

# One Container Is Just `docker run` — But Hundreds?

Starting a single container takes one line: `docker run`. The problem is everything after that.

You need to start dozens to hundreds of containers, spread across multiple servers, bring them back when they die, swap to new versions with zero downtime, and route traffic only to the healthy ones. Imagine doing all of this by hand:

- Calculating which server has spare capacity every single time (bin-packing)
- Constantly polling whether a process has died
- Restarting on death, and relocating to another server when a host itself dies
- Pulling one node out at a time during deploys, adding the new one, checking health...

**A control system that automates these repetitive decisions** is exactly what a container orchestrator (ECS, Kubernetes…) is.

In this post I want to understand ECS **as a set of principles, not a magic box**. There are exactly two guiding questions:

> 1. **When ECS starts a container, what exactly does it read, from where, and in what order?**
> 2. **By what mechanism does it keep monitoring whether a running container is alive?**

And toward the end, I go past basic `awsvpc` mode into the **internal network backbone of ECS** (trunk/branch ENI, the CNI plugin chain, PrivateLink, service-to-service communication).

For context, what I actually took over was a migration of a background **Worker** service. But since the principles of how ECS starts and monitors containers are the same for any service, I'll explain using something easier to picture — **a simple web API server** (say, one that takes requests on port 8000). Assume we're running that single server on ECS, and let's walk through its Task Definition line by line.

---

# What a Container Really Is — Not a "Lightweight VM"

To understand ECS, you first have to know that a container is **not a "lightweight VM" but an "isolated Linux process."** It's built from two kernel features.

![표 1](https://media.vlpt.us/images/5hseok/post/d6d45557-4b77-4940-9384-a2ef4de5c03a/table1_riieews9.png)


The `"cpu": 256` and `"memory": 1024` you write in a Task Definition go straight into these **cgroup limits**. A setting like `"ulimits": { "nofile": 65535 }` caps how many files/sockets that process can open (Linux rlimit).

![다이어그램 1](https://media.vlpt.us/images/5hseok/post/78fb9977-2422-495b-8c6f-c7450038bc26/diagram1_uo1tvm7u.png)

> 💡 That's why containers boot fast. A VM boots an entire kernel too, but a container **shares the host kernel** and just puts up partitions with namespaces/cgroups. No new kernel to start, so of course it's fast.

---

# ECS Architecture — Control Plane vs Data Plane

Everything in ECS comes down to **the separation of two planes**. This isn't unique to ECS — it's a structure you see everywhere in distributed systems.

![표 2](https://media.vlpt.us/images/5hseok/post/aa80d117-a2e8-4e68-80ed-6b01e458305c/table2_v3uc_lls.png)


On each EC2 in the Data Plane runs a small program called the **ECS Agent**. This agent is the bridge between the control plane and the data plane.

![다이어그램 2](https://media.vlpt.us/images/5hseok/post/2de436d3-dd81-40a3-a6c3-cf884d85744b/diagram2_kppqxdop.png)

Here's an easy point to get confused about: **who sends commands to whom?**

The control plane does *not* push "do this" to the agent. The opposite — **the agent periodically goes to the control plane and asks, "Anything for me to do? Here's my status,"** i.e. it polls. If that heartbeat stops, the control plane decides "is that instance dead?" (We'll see this again in the monitoring section.)

---

# Launch Type — Who Manages the Data Plane (EC2 vs Fargate)

I just called the Data Plane "owned by us (EC2)," but that's really just one option. What decides **who manages the infrastructure your containers actually run on** is the **launch type**, and there are broadly two.

## EC2 launch type — I run the instances myself

We launch EC2 instances, put the ECS Agent on them, and register them with the cluster. The "Data Plane = our EC2 + ECS Agent" structure I've described so far is exactly this.

- **Pros**: Full control of the instance. Pick the instance type (CPU/memory/GPU), customize the AMI, keep a daemon (a monitoring agent, etc.) resident on the host, and optimize cost with reserved/spot instances.
- **Cons**: You have to handle instance patching, capacity planning, and scaling (ASG) yourself. You also worry about bin-packing, and idle capacity is just money leaking.

## Fargate — AWS handles the infra, I bring only the container

Fargate is **serverless**. It launches no EC2 instances at all. You just specify resources on the Task — like "0.5 vCPU, 1GB memory" — and AWS starts the container somewhere on its own. You see neither instances nor an ECS Agent.

- **Pros**: Infra management disappears. No patching, no capacity planning. You think only in terms of Tasks, and it reacts quickly even to traffic that suddenly spikes from zero.
- **Cons**: No host-level control (can't keep a resident daemon, can't pick an instance type). Billing is by the Task's vCPU·memory × time, so a workload running full-tilt 24/7 can cost more than EC2.

![다이어그램 3](https://media.vlpt.us/images/5hseok/post/aedfed04-a3d0-4f22-a891-92e1e1d051f7/diagram3_vi9wr5t9.png)

![표 3](https://media.vlpt.us/images/5hseok/post/34738725-e925-4388-96ad-4be5d5a909be/table3_vryudewg.png)


> 💡 Either way, **the boot flow, monitoring, and reconciliation principles are identical.** Fargate just means "AWS manages the Data Plane for you" — ECS still keeps the desired number of Tasks and watches their health the same way. So the rest of this post applies to both. (One caveat: the earlier point about "can't reach the host's monitoring agent over localhost" assumes the EC2 launch type, which has a host. Fargate has no such host concept at all.)

---

# Object Model — How the 6 Concepts Relate

ECS throws so many terms at you up front that it makes your head spin. Let's pin down just the core six and how they connect.

![다이어그램 4](https://media.vlpt.us/images/5hseok/post/a52b6c8a-120f-4493-a046-caed0b854e9e/diagram4_d1450c2z.png)

![표 4](https://media.vlpt.us/images/5hseok/post/d6f8f905-76a2-46e9-8cfa-56468d9f0f9f/table4_c7545t57.png)


The most important thing here is that **a Task Definition never changes once registered (immutable)**. Change a setting and a new revision is created. So "which version was running" is always unambiguous. That immutability is what makes rollback easy.

---

# 🚀 The Boot Flow — 9 Steps Until a Container Is Up

> **Answer to question 1**: "What does ECS read, from where, and in what order?"

From the moment a Service decides "I need one more Task" to the moment the container receives traffic, let's follow it in 9 steps.

![다이어그램 5](https://media.vlpt.us/images/5hseok/post/1e140c13-3dd9-4530-9940-6f3565c028f5/diagram5_lmop93qv.png)

Here's a table of **which part of the Task Definition ECS reads** at each step.

![표 5](https://media.vlpt.us/images/5hseok/post/fc62d23b-9422-404e-af89-2aa78395b864/table5_yii6iy7x.png)


A few spots are worth a closer look.

**② Placement** — the scheduler picks "an instance with free space where this Task's `cpu:256, memory:1024` fits." This is the **bin-packing problem**. Whether to pack resources tightly onto a host or spread them across many is tuned by the placement strategy.

**③ ENI allocation** — with `awsvpc`, each Task gets its own ENI (Elastic Network Interface) with **its own IP**. So a Task ends up with a different IP than the host, which later becomes the root cause of issues like "why can't I reach the host over localhost?" (more in the networking section).

**⑤ Injecting secrets (the most confusing part)** — the `secrets[]` in a Task Definition hold **not values but addresses (Parameter Store ARNs)**. At boot, the agent goes to those addresses, reads the real values, and puts them into the container as env vars. So:

- There are no secrets baked into the image (which is the point, for security). Crack open the image and you won't find a password.
- But if Parameter Store has no value or you lack permission? → the Task can't reach RUNNING, failing with **`ResourceInitializationError: unable to pull secrets`**. Everyone hits this at least once when they first touch ECS.

**⑦ ENTRYPOINT → CMD** — straight Linux process model. The ENTRYPOINT script comes up as the container's PID 1, and at the end it `exec`s into CMD (here, uvicorn), **handing over PID 1**. That `exec` matters more than you'd think: signals (SIGTERM, etc.) must reach uvicorn directly for graceful shutdown. If a wrapper script holds onto PID 1, the app never receives the termination signal and tends to get force-killed (SIGKILL).

---

# 👁️ How Monitoring Works — There's More Than One Health Signal

> **Answer to question 2**: "How does ECS keep monitoring whether something is alive?"

The key is that there isn't one health signal but **three**, each watching something different. And each signal drives a **state machine**.

## The triple health check — who watches what

![다이어그램 6](https://media.vlpt.us/images/5hseok/post/2d00e057-31fe-4251-a913-0dcc88288af3/diagram6_v0lfuaer.png)

![표 6](https://media.vlpt.us/images/5hseok/post/c6663595-7e43-4106-963f-814c5cad5867/table6_cf89cj32.png)


**Why three of them?** Because each has a different blind spot.

- ① is "does the process itself respond" — catches app-internal deadlocks.
- ② is "can this EC2/Task even communicate" — catches whole-instance failures.
- ③ is "is it reachable on the **user's path**" — catches security-group/network/LB-path problems.

Watch only one and you'll always miss some class of failure. So you monitor in layers: inside, beside, outside.

## What startPeriod means — the device that prevents a crash loop

The container health check runs a `STARTING → HEALTHY / UNHEALTHY` state machine.

![다이어그램 7](https://media.vlpt.us/images/5hseok/post/0f03a77f-1816-47b6-b9b7-034b25d185c6/diagram7_w_71tm88.png)

> 💡 **Why `startPeriod` matters** — while an app is booting (creating a DB connection pool, loading models, waiting on migrations), it's normal for the health check to fail briefly. Without this grace window you fall into a **crash loop**: "slow boot → health fails → restart → slow boot again." So the slower your service boots, the more generous the startPeriod should be.

## Task lifecycle — the words you'll see in the logs

A Task passes through these states from birth to death. You'll meet these words in the console and logs.

![다이어그램 8](https://media.vlpt.us/images/5hseok/post/296deb40-8e07-4e67-baa5-c2fde3ffca72/diagram8_6prem7o2.png)

- **Stuck at PROVISIONING/PENDING** → likely a step ④⑤ (image/secrets) problem from the boot flow. `unable to pull secrets` is the classic symptom.
- **The grace in STOPPING** → during the graceful-shutdown timeout, in-flight requests are drained before termination. Exceed it and it's force-killed with SIGKILL.

## Self-healing in one frame

Put these signals together and you get the "dies and comes back on its own" behavior.

![다이어그램 9](https://media.vlpt.us/images/5hseok/post/bdca1c36-60f3-4752-8a89-e01560f110d6/diagram9__gsy28ke.png)

---

# Reconciliation Loop — the Heart of ECS

ECS Service behavior in one sentence:

> **"An infinite loop that endlessly compares desired state with current state and closes the gap."**

![다이어그램 10](https://media.vlpt.us/images/5hseok/post/d918f769-2664-4498-8ec0-d6793b1850e6/diagram10_25lqgnd0.png)

This single loop explains **almost everything**.

- **A Task dies** → running 1 < desired 2 → start a new one (self-heal)
- **Scale out** → set desiredCount to 3 → running 2 < 3 → add one
- **Rolling deploy** → fill desired with the new revision while draining the old
- **Instance failure** → its Tasks drop out of running → rescheduled onto other instances

For the record, this isn't an ECS invention. Kubernetes controllers work the same way. It's commonly called the **declarative** approach: instead of saying "do it like *this* (how)," you only declare **"what should be true,"** and the system makes it so. Most cloud orchestration tools work this way today.

Deployment is just an application of this loop. A **rolling deploy** is reconciliation done "a little at a time."

![다이어그램 11](https://media.vlpt.us/images/5hseok/post/24841d7b-5e88-44d6-a812-4011a3ee8b63/diagram11_6pctiu4s.png)

How many to swap at once is tuned by `minimumHealthyPercent` / `maximumPercent` (e.g. 100%/200% means bring all the new ones up, then take the old ones down).

---

# Networking Deep Dive — From awsvpc to the ENI Backbone

This is where the post goes deepest. Many ECS articles stop at "with awsvpc each Task gets an IP," but let's see **how that IP physically gets inside the container**, and how you raise the cap on Tasks-per-host.

## awsvpc & ENI basics

First the basics. Assume our Task Definition uses `networkMode: awsvpc`.

![다이어그램 12](https://media.vlpt.us/images/5hseok/post/7407bcf3-a68c-4be8-8b29-23e24b23935e/diagram12_j_pf_uco.png)

![표 7](https://media.vlpt.us/images/5hseok/post/c3e6d57c-bd85-455b-bce7-6640e0884375/table7_9o86mc8x.png)


The essence of awsvpc is that **a Task becomes a first-class network member inside the VPC, on equal footing with an EC2 instance.** Each Task gets an ENI (a virtual NIC) and a private VPC IP. So you can apply security groups per Task, and the ALB sends traffic directly to the Task's **ENI IP:container-port**.

There's a side effect, though. Because a Task has a **different IP than the host**, inside the container you can't reach another process on the host (e.g. a monitoring agent running on the host) over `localhost`. In that case you have to **look up the host's real IP** via the instance metadata service (IMDSv2) and send to that address. It's a trap you'll hit at some point with awsvpc.

## How the ENI gets inside the container — the CNI plugin chain

So **how** does that ENI get into the container's network namespace? Here's where the **CNI (Container Network Interface) plugins** come in.

When starting a Task, the ECS Agent **invokes a chain of CNI plugins** to configure the container's network namespace. The key idea is that it **"moves" the ENI attached to the host into the container's namespace.**

![다이어그램 13](https://media.vlpt.us/images/5hseok/post/2a888486-d84c-4c8f-933d-fbdfec386911/diagram13_vu9h257z.png)

The plugin chain roughly splits the work like this.

- **ENI plugin** — moves the ENI attached to the host into the container's network namespace and sets up routing. This is the core of awsvpc.
- **Bridge plugin** — creates a bridge for intra-Task communication or auxiliary interfaces.
- **IPAM plugin** — manages IP address allocation/reclamation.

> 💡 Notice **namespace** showing up again. Earlier I said "a container is a namespace-isolated process"; the **network namespace** is the copy that isolates just the network stack (interfaces, routing tables, iptables). Multiple containers in one Task **share the same network namespace** — which is exactly why containers in the same Task can talk to each other over `localhost`.

## trunk/branch ENI — breaking the Tasks-per-host ceiling

awsvpc has a real-world headache: **each EC2 instance type has a fixed number of ENIs you can attach.** Since each Task eats one ENI, on a small instance you can hit the ENI cap and **be unable to start more Tasks even though CPU and memory are still free.**

The fix is **ENI trunking.**

![다이어그램 14](https://media.vlpt.us/images/5hseok/post/a4b5fadc-9ee5-4993-b362-b02ba2be1669/diagram14_k7u9rlsz.png)

When you enable trunking (the `awsvpcTrunking` account setting), ECS attaches one **trunk ENI** to the instance, and Tasks receive **branch ENIs** hanging off that trunk. The ENIs the host directly consumes stay fixed at primary 1 + trunk 1, while the actual Task IPs expand as branches under the trunk.

![표 8](https://media.vlpt.us/images/5hseok/post/f5937df0-5648-46b9-907f-ae083cae0a29/table8_smyem1z1.png)


For example, where a small instance was capped at 2 Tasks without trunking, enabling it lets you run far more on the same instance. (The high Task density Fargate achieves internally is not unrelated to this trunk/branch ENI structure.)

## VPC backbone & PrivateLink — traffic that never touches the internet

For ECS to work, it constantly talks to AWS services like the control plane (ECS API), ECR, and Parameter Store. But what if that traffic **goes out over the public internet and back**? Latency rises, and you're exposed to the internet, security-wise.

That's why you use **VPC Endpoints (PrivateLink)**. With PrivateLink in place, calls to services like ECS/ECR/Parameter Store **stay inside AWS's internal network backbone and never traverse the internet.**

![다이어그램 15](https://media.vlpt.us/images/5hseok/post/3b0ecede-0b72-47e9-b24e-8dac3d44998a/diagram15_jcxxtjox.png)

Practically, this buys you two things.

- **Security** — Tasks in a private subnet can pull images from ECR and read secrets without an internet gateway/NAT. You don't even have to open an outbound path.
- **Performance & cost** — no internet round-trip means lower latency, and you save on NAT gateway data-processing costs.

## Service-to-service communication — Service Discovery vs Service Connect

Finally, how do Tasks (services) find and talk to each other? Tasks die and come back with constantly changing IPs, so hard-coding is out. AWS offers two approaches.

![표 9](https://media.vlpt.us/images/5hseok/post/75d337e2-1224-42f6-814a-218951ec0800/table9___o978jq.png)


![다이어그램 16](https://media.vlpt.us/images/5hseok/post/1d648fa9-0f6b-44dd-b989-f1b8a059429f/diagram16_5xnropud.png)

In short, **Service Discovery is the lightweight DNS-name-resolution approach**, and **Service Connect is the heavier approach that slots in a proxy for faster failover and observability.** If you hate traffic going to a dead Task for a while because of DNS caching, Service Connect fits; if you want something simple and light, Service Discovery fits. Note, though, that Service Connect is incompatible with some deployment controllers (e.g. Blue/Green), so check before adopting it.

---

# Resource Isolation & the 3 IAM Roles

## Resource isolation — values that fall through to cgroup

Let's see what the cgroup limits from boot-step 6 actually do.

![표 10](https://media.vlpt.us/images/5hseok/post/207b530b-be48-4bba-b55f-065fb364e312/table10_f_psxjc1.png)


> 💡 A memory overshoot **always kills (OOM kill)**. So set the memory limit from real measurements plus headroom. CPU, on the other hand, doesn't kill on overshoot — it just throttles (slows down). Not knowing this difference, you can spend ages chasing "why did the container suddenly die?"

## The 3 IAM roles — the most commonly confused part

ECS has **three roles with different purposes**. If you can't tell them apart, you won't know where to look when a permission error hits.

![다이어그램 17](https://media.vlpt.us/images/5hseok/post/d2a54256-17fd-474a-893f-643991b8901b/diagram17_34vb2w2p.png)

![표 11](https://media.vlpt.us/images/5hseok/post/66010f46-e767-47c2-ab3c-3e5e5c7e1eef/table11_f1e1juvx.png)


In one sentence:

> **execution role = "the permissions ECS uses to start the container,"** while **task role = "the permissions the started app uses to do its job."**

The symptom tells them apart too. **Boot fails because it can't read a secret** → execution role problem. **The app is up but a permission error on an S3 call** → task role problem. The symptom points straight to which role to check.

---

# The Whole Picture in One Frame

Tying it all together:

![다이어그램 18](https://media.vlpt.us/images/5hseok/post/8d262fac-8c2e-41c6-9b7b-2521ddf4d29e/diagram18_kdak_dcu.png)

## Just remember these 5 things

1. **You only declare the goal** — I just say "this is how it should be," and the reconciliation loop compares with current state and closes the gap.
2. **control plane (decide) ↔ data plane (execute) separated**, with the agent bridging via pull (polling).
3. **Boot = read blueprint → placement → ENI → image pull → secrets → create container with cgroup → ENTRYPOINT**.
4. **Monitoring = triple health (inside/beside/outside) + state machines**. startPeriod prevents the crash loop.
5. **Networking = one ENI per Task via awsvpc**; the CNI plugin moves that ENI into the namespace, and trunk/branch ENI raises density.

---

# Glossary

![표 12](https://media.vlpt.us/images/5hseok/post/28de8e80-5ccc-402e-9f80-8b46d3ff7183/table12_gc9rvs2w.png)


---

That's a walk through ECS internals using a single Task Definition as the textbook. It's daunting at first with dozens of terms, but it nearly all ties together with one sentence — **"declare the goal and the loop makes it so"** — plus three axes: **boot order / triple health / awsvpc ENI**. Next time you see words like `PROVISIONING` or `unable to pull secrets` in the ECS console, you'll know exactly which step you're stuck at.

---

## 📚 References

- [Under the Hood: Task Networking for Amazon ECS (AWS Compute Blog)](https://aws.amazon.com/blogs/compute/under-the-hood-task-networking-for-amazon-ecs/)
- [Allocate a network interface for an Amazon ECS task — awsvpc (AWS Docs)](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking-awsvpc.html)
- [Increasing Amazon ECS Linux container instance network interfaces — ENI trunking (AWS Docs)](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/container-instance-eni.html)
- [amazon-ecs-cni-plugins (GitHub) — ENI / Bridge / IPAM plugins](https://github.com/aws/amazon-ecs-cni-plugins)
- [Use Service Connect to connect Amazon ECS services (AWS Docs)](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect.html)

