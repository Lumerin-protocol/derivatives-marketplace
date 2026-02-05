# Futures Subgraph

This subgraph indexes the Futures contract and HashrateOracle contract to track positions, orders, and hashrate data.

## Entities

### Futures Contract Entities

- **Participant**: Tracks users who create positions or orders

  - `id`: Participant address
  - `positions`: Array of position IDs
  - `orders`: Array of order IDs
  - `positionCount`: Number of positions
  - `orderCount`: Number of orders
  - `totalVolume`: Total volume traded

- **Position**: Tracks individual futures positions

  - `id`: Position ID (bytes32)
  - `participant`: Participant who created the position
  - `price`: Position price
  - `deliveryDate`: Delivery date for the position
  - `isBuy`: Whether this is a buy (long) or sell (short) position
  - `timestamp`: When the position was created
  - `isActive`: Whether the position is still active
  - `closedAt`: When the position was closed (if closed)
  - `closedBy`: Who closed the position

- **Order**: Tracks futures orders between participants
  - `id`: Order ID (bytes32)
  - `seller`: Seller participant
  - `buyer`: Buyer participant
  - `price`: Order price
  - `startTime`: When the order starts
  - `timestamp`: When the order was created
  - `isActive`: Whether the order is still active
  - `closedAt`: When the order was closed (if closed)
  - `closedBy`: Who closed the order

### HashrateOracle Timeseries Entities

- **HashesForBTC**: Tracks updates to the hashes per BTC value

  - `id`: Unique identifier (block number + log index)
  - `value`: Number of hashes required per BTC
  - `updatedAt`: When the value was updated
  - `ttl`: Time-to-live for the value
  - `blockNumber`: Block number of the update
  - `transactionHash`: Transaction hash

- **HashesForToken**: Tracks calculated hashes per token values
  - `id`: Unique identifier (block number + log index)
  - `value`: Calculated hashes per token value
  - `calculatedAt`: When the calculation was performed
  - `blockNumber`: Block number
  - `transactionHash`: Transaction hash
  - `btcPrice`: BTC price at time of calculation
  - `hashesForBTC`: Hashes per BTC value used in calculation

## Event Handlers

### Futures Contract Events

1. **Initialized**: Creates the root Futures entity when the contract is initialized
2. **PositionCreated**: Creates a new position entity and updates participant stats
3. **PositionClosed**: Marks a position as closed and updates stats
4. **OrderCreated**: Creates a new order entity and updates participant stats
5. **OrderClosed**: Marks an order as closed and updates stats

### HashrateOracle Events

1. **Initialized**: Initializes contract instance and creates initial timeseries data point
2. **HashesForBTCUpdated**: Creates a new HashesForBTC entity and collects comprehensive hashrate data
3. **Block Handler**: Collects hashrate data on every block for comprehensive timeseries coverage

## Timeseries Collection

The subgraph collects timeseries data for `hashesForBTC` and `hashesForToken` using multiple approaches:

1. **Event-based Collection**: Data is collected when `HashesForBTCUpdated` events are emitted
2. **Block-based Collection**: Data is collected on every block to ensure comprehensive coverage
3. **Futures Event Integration**: Data is collected when Futures contract events occur

This multi-layered approach ensures we have a complete historical record of hashrate calculations and their relationship to market activity.

## Configuration

The subgraph is configured in `subgraph.template.yaml` with:

- Futures contract address and ABI
- HashrateOracle contract address and ABI
- Event handlers for all relevant events

## Usage

1. Deploy the subgraph using the template configuration
2. The subgraph will automatically index all Futures and HashrateOracle events
3. Query the entities to get position, order, and hashrate data
4. Use the timeseries data to analyze hashrate trends over time

## Example Queries

```graphql
# Get all active positions
{
  positions(where: { isActive: true }) {
    id
    participant
    price
    deliveryDate
    isBuy
  }
}

# Get hashrate timeseries data
{
  hashesForTokens(orderBy: calculatedAt, orderDirection: desc, first: 100) {
    value
    calculatedAt
    btcPrice
    hashesForBTC
  }
}

# Get participant activity
{
  participants {
    id
    positionCount
    orderCount
    totalVolume
  }
}
```
