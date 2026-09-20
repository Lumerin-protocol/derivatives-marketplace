export const TickBitmapHarnessAbi = [
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "tick",
        "type": "uint64"
      }
    ],
    "name": "flipTick",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "tick",
        "type": "uint64"
      }
    ],
    "name": "isInitialized",
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
        "internalType": "uint64",
        "name": "tick",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "maxTick",
        "type": "uint64"
      }
    ],
    "name": "nextAsk",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "next",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "found",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "tick",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "minTick",
        "type": "uint64"
      }
    ],
    "name": "nextBid",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "next",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "found",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "tick",
        "type": "uint64"
      }
    ],
    "name": "nextInitializedTickGte",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "next",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "found",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "tick",
        "type": "uint64"
      }
    ],
    "name": "nextInitializedTickLte",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "next",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "found",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;
