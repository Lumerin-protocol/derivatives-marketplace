export const OptionSettlementAbi = [
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
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "AlreadyFinalized",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "AlreadyInitiated",
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
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "ExpiryNotReached",
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
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "internalType": "uint32",
        "name": "have",
        "type": "uint32"
      },
      {
        "internalType": "uint32",
        "name": "need",
        "type": "uint32"
      }
    ],
    "name": "InsufficientObservations",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInitialization",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidOracle",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidWindow",
    "type": "error"
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
        "name": "user",
        "type": "address"
      }
    ],
    "name": "NoPosition",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotInitializing",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "NotInitiated",
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
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "SeriesNotSettled",
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
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "WindowClosed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "WindowNotElapsed",
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
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "count",
        "type": "uint32"
      }
    ],
    "name": "ObservationRecorded",
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
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "user",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "int256",
        "name": "pnlWad",
        "type": "int256"
      }
    ],
    "name": "SettlementClaimed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "twapPrice",
        "type": "uint256"
      }
    ],
    "name": "SettlementFinalized",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "windowEnd",
        "type": "uint64"
      }
    ],
    "name": "SettlementInitiated",
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
    "name": "claimSettlement",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "engine",
    "outputs": [
      {
        "internalType": "contract OptionMarginEngine",
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
      }
    ],
    "name": "finalizeSettlement",
    "outputs": [],
    "stateMutability": "nonpayable",
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
    "name": "getSettlementWindow",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint64",
            "name": "initiatedAt",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "windowEnd",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "cumulativePrice",
            "type": "uint256"
          },
          {
            "internalType": "uint32",
            "name": "observationCount",
            "type": "uint32"
          },
          {
            "internalType": "bool",
            "name": "finalized",
            "type": "bool"
          }
        ],
        "internalType": "struct OptionSettlement.SettlementWindow",
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
      },
      {
        "internalType": "address",
        "name": "_engine",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_oracle",
        "type": "address"
      },
      {
        "internalType": "uint64",
        "name": "_windowDuration",
        "type": "uint64"
      },
      {
        "internalType": "uint32",
        "name": "_minObservations",
        "type": "uint32"
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
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "initiateSettlement",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "minObservations",
    "outputs": [
      {
        "internalType": "uint32",
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "oracle",
    "outputs": [
      {
        "internalType": "contract AggregatorV3Interface",
        "name": "",
        "type": "address"
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
        "name": "user",
        "type": "address"
      }
    ],
    "name": "previewPayoff",
    "outputs": [
      {
        "internalType": "int256",
        "name": "pnlWad",
        "type": "int256"
      }
    ],
    "stateMutability": "view",
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
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "recordObservation",
    "outputs": [],
    "stateMutability": "nonpayable",
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
    "inputs": [
      {
        "internalType": "uint32",
        "name": "_min",
        "type": "uint32"
      }
    ],
    "name": "setMinObservations",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "_duration",
        "type": "uint64"
      }
    ],
    "name": "setSettlementWindowDuration",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "settlementWindowDuration",
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
