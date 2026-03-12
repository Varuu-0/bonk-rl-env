# Manifold Server Architecture Diagram

```mermaid
graph TD
    %% Main Components
    A[main.ts] --> B[IPC Bridge]
    A --> C[Worker Pool]
    
    %% IPC Module
    B[IPC Bridge] --> D[ZeroMQ Router]
    B --> E[JSON Command Handling]
    B --> F[Telemetry Integration]
    
    %% Worker System
    C[Worker Pool] --> G[Worker Threads]
    C --> H[Shared Memory Manager]
    C --> I[Message Passing Fallback]
    G --> J[BonkEnvironment Instances]
    
    %% Core Modules
    J --> K[Environment]
    J --> L[Physics Engine]
    J --> M[PRNG]
    
    %% Physics Engine Details
    L --> N[Box2D Wrapper]
    L --> O[Collision Detection]
    L --> P[Grappling Joints]
    L --> Q[Heavy State Management]
    L --> R[Telemetry Wrapping]
    
    %% Environment Details
    K --> S[Gymnasium-style API]
    K --> T[Reward Calculation]
    K --> U[Observation Building]
    K --> V[Opponent Policies]
    
    %% Shared Memory
    H --> W[SharedArrayBuffer]
    H --> X[Ring Buffer for Actions]
    H --> Y[Atomic Synchronization]
    H --> Z[Binary Data Views]
    
    %% Legacy System (Separate)
    AA[Legacy Server] --> AB[Express/Socket.IO]
    AA --> AC[Player Management]
    AA --> AD[Rate Limiting]
    AA --> AE[Host Management]
    AA --> AF[Chat Logging]
    AA --> AG[Terminal CLI]
    
    %% Telemetry System
    AH[Telemetry Controller] --> AI[CLI Flag Parsing]
    AH --> AJ[Environment Overrides]
    AH --> AK[Config Merging]
    AH --> AL[Fast-path Enabled Check]
    AH --> AM[Automatic Reporting]
    AH --> AN[Worker Telemetry Gathering]
    
    AO[Profiler] --> AP[BigUint64Array Accumulator]
    AO --> AQ[Function Wrapping Decorator]
    AO --> AR[Legacy API (start/end/increment/gauge)]
    AO --> AS[Heatmap Reporting]
    AO --> AT[Worker Statistics Aggregation]
    
    %% Types Module
    AU[Types Index] --> AV[BanList]
    AU --> AW[UsernameRestrictions]
    AU --> AX[LevelRestrictions]
    AU --> AY[RatelimitRestrictions]
    AU --> AZ[Config & GameSettings]
    AU --> BA[Avatar & Player Types]
    AU --> BB[TelemetryFlags & TelemetryConfig]
    
    %% Data Flow (RL Training)
    style A fill:#f9f,stroke:#333
    style B fill:#bbf,stroke:#333
    style C fill:#bbf,stroke:#333
    style J fill:#bfb,stroke:#333
    style K fill:#bfb,stroke:#333
    style L fill:#bfb,stroke:#333
    style H fill:#ff9,stroke:#333
    style AH fill:#f99,stroke:#333
    style AO fill:#f99,stroke:#333
    style AA fill:#999,stroke:#333
    
    %% Legend
    classDef main fill:#f9f,stroke:#333;
    classDef ipc fill:#bbf,stroke:#333;
    classDef worker fill:#bbf,stroke:#333;
    classDef core fill:#bfb,stroke:#333;
    classDef shared fill:#ff9,stroke:#333;
    classDef telemetry fill:#f99,stroke:#333;
    classDef types fill:#9fb,stroke:#333;
    classDef legacy fill:#999,stroke:#333;
    
    class A main;
    class B,C ipc;
    class G,H,I,J worker;
    class K,L,M core;
    class H shared;
    class AH,AO telemetry;
    class AU types;
    class AA,AB,AC,AD,AE,AF,AG legacy;