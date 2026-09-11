export const OptionOrderBookAbi = [
  {
    "inputs": [],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      }
    ],
    "name": "AddressEmptyCode",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "ERC1967InvalidImplementation",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ERC1967NonPayable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FailedCall",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      },
      {
        "internalType": "uint128",
        "name": "fillSize",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "remaining",
        "type": "uint128"
      }
    ],
    "name": "FillExceedsRemaining",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInitialization",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPrice",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSize",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotInitializing",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotRouter",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "name": "OrderNotActive",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "OwnableInvalidOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "OwnableUnauthorizedAccount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UUPSUnauthorizedCallContext",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "slot",
        "type": "bytes32"
      }
    ],
    "name": "UUPSUnsupportedProxiableUUID",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "version",
        "type": "uint64"
      }
    ],
    "name": "Initialized",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "name": "OrderCanceled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "fillSize",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "remainingAfter",
        "type": "uint128"
      }
    ],
    "name": "OrderFilled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      },
      {
        "indexed": true,
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "trader",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "isBuy",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "priceTicks",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "size",
        "type": "uint128"
      }
    ],
    "name": "OrderPlaced",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOwner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "oldRouter",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newRouter",
        "type": "address"
      }
    ],
    "name": "RouterUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "Upgraded",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "UPGRADE_INTERFACE_VERSION",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "bestAsk",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "priceTicks",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "bestBid",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "priceTicks",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "name": "cancelOrder",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "trader",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "seriesId",
            "type": "uint64"
          },
          {
            "internalType": "bool",
            "name": "isBuy",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "postOnly",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "reduceOnly",
            "type": "bool"
          },
          {
            "internalType": "uint128",
            "name": "size",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "remaining",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "priceTicks",
            "type": "uint64"
          }
        ],
        "internalType": "struct OptionOrderBook.Order",
        "name": "order",
        "type": "tuple"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      },
      {
        "internalType": "uint128",
        "name": "fillSize",
        "type": "uint128"
      }
    ],
    "name": "fillOrder",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "priceTicks",
        "type": "uint64"
      },
      {
        "internalType": "address",
        "name": "trader",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "name": "getOrder",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "trader",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "seriesId",
            "type": "uint64"
          },
          {
            "internalType": "bool",
            "name": "isBuy",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "postOnly",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "reduceOnly",
            "type": "bool"
          },
          {
            "internalType": "uint128",
            "name": "size",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "remaining",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "priceTicks",
            "type": "uint64"
          }
        ],
        "internalType": "struct OptionOrderBook.Order",
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
        "name": "_registry",
        "type": "address"
      }
    ],
    "name": "initialize",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "name": "isOrderActive",
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
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "isBuy",
        "type": "bool"
      },
      {
        "internalType": "uint64",
        "name": "priceTicks",
        "type": "uint64"
      }
    ],
    "name": "levelDepth",
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
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "isBuy",
        "type": "bool"
      },
      {
        "internalType": "uint64",
        "name": "afterTick",
        "type": "uint64"
      }
    ],
    "name": "nextLevel",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "nextTick",
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
    "inputs": [],
    "name": "nextOrderId",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "isBuy",
        "type": "bool"
      },
      {
        "internalType": "uint64",
        "name": "priceTicks",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "afterOrderId",
        "type": "uint64"
      }
    ],
    "name": "nextOrderInQueue",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "internalType": "address",
        "name": "trader",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "isBuy",
        "type": "bool"
      },
      {
        "internalType": "uint64",
        "name": "priceTicks",
        "type": "uint64"
      },
      {
        "internalType": "uint128",
        "name": "size",
        "type": "uint128"
      },
      {
        "internalType": "bool",
        "name": "postOnly",
        "type": "bool"
      },
      {
        "internalType": "bool",
        "name": "reduceOnly",
        "type": "bool"
      }
    ],
    "name": "placeOrder",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "proxiableUUID",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "registry",
    "outputs": [
      {
        "internalType": "contract OptionMarketRegistry",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "renounceOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "router",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_router",
        "type": "address"
      }
    ],
    "name": "setRouter",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newImplementation",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "upgradeToAndCall",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
] as const;
