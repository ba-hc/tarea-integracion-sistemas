# Contract-level acceptance matrix

These tests define the black-box acceptance baseline and must not require changes to the frozen interface.

## Auth
- no key GET customer -> 401
- invalid key -> 401
- reader GET -> success
- reader POST -> 403
- operator POST -> success

## Customers
- create valid -> 201 + Location
- duplicate normalized email -> 409
- get absent -> 404
- pagination defaults and max validation

## Orders
- valid customer + all stock available -> 201 CONFIRMED
- unknown customer -> 404, Inventory not mutated
- unknown part -> 422, no partial stock mutation
- insufficient stock -> 409, no partial stock mutation
- duplicate part IDs in request -> 400
- invalid quantity -> 400
- same Idempotency-Key + same payload -> same order, no second stock decrement
- same Idempotency-Key + different payload -> 409

## Cancellation
- confirmed order -> 200 CANCELLED and stock restored once
- repeated cancel -> 200 same CANCELLED state and no second release
- unknown order -> 404

## Dependency failure
- Inventory stopped -> create/cancel returns 503 in bounded time
- Inventory delayed beyond 800 ms -> create/cancel returns 504
- order must not become CONFIRMED when reserve fails
- order must not become CANCELLED when release fails

## Inventory concurrency
Given stock=10, 20 concurrent reservations of quantity 1 for distinct order IDs must produce exactly 10 successes, 10 stock failures and final stock 0.

## Docker
From a clean state, `docker compose up --build` must be sufficient to start all mandatory services.
