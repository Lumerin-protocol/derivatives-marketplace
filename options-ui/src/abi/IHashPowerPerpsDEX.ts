export const IHashPowerPerpsDEXAbi = [
  {
    "inputs": [],
    "name": "QUANTITY_DECIMALS",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getMarketPrice",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getPendingFunding",
    "outputs": [
      {
        "internalType": "int256",
        "name": "",
        "type": "int256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getUnrealizedPnl",
    "outputs": [
      {
        "internalType": "int256",
        "name": "",
        "type": "int256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getUserPosition",
    "outputs": [
      {
        "components": [
          {
            "internalType": "int256",
            "name": "netQuantity",
            "type": "int256"
          },
          {
            "internalType": "uint256",
            "name": "aggregatedEntryPrice",
            "type": "uint256"
          }
        ],
        "internalType": "struct IHashPowerPerpsDEX.Position",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "isLiquidatable",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_user",
        "type": "address"
      }
    ],
    "name": "getRiskView",
    "outputs": [
      {
        "components": [
          {
            "internalType": "int256",
            "name": "netPositionDelta",
            "type": "int256"
          },
          {
            "internalType": "int256",
            "name": "unrealizedPnl",
            "type": "int256"
          },
          {
            "internalType": "int256",
            "name": "pendingFunding",
            "type": "int256"
          },
          {
            "internalType": "uint256",
            "name": "buyOrderDelta",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "sellOrderDelta",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "buyOrderFillLoss",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "sellOrderFillLoss",
            "type": "uint256"
          }
        ],
        "internalType": "struct ILinearMarket.RiskView",
        "name": "view_",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_user",
        "type": "address"
      }
    ],
    "name": "getOrderAggregate",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "buyQty",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "sellQty",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "buyValue",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "sellValue",
            "type": "uint256"
          }
        ],
        "internalType": "struct HashPowerPerpsDEXBase.OrderAggregate",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;
