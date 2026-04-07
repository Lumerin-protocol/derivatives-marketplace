export const OptionMarketRegistryAbi = [
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
    "inputs": [],
    "name": "InvalidExpiry",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidIV",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInitialization",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLotSize",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidStrike",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTickSize",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAuthorized",
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
    "name": "SeriesAlreadySettled",
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
    "name": "SeriesNotActive",
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
    "name": "SeriesNotActiveOrFrozen",
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
    "name": "SeriesNotFound",
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
        "indexed": true,
        "internalType": "address",
        "name": "addr",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "authorized",
        "type": "bool"
      }
    ],
    "name": "AuthorizedContractSet",
    "type": "event"
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
        "indexed": false,
        "internalType": "uint64",
        "name": "strikeE8",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "expiryTs",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "isCall",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "tickSizeE8",
        "type": "uint32"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "lotSize",
        "type": "uint32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "initialIV",
        "type": "uint256"
      }
    ],
    "name": "SeriesCreated",
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
      }
    ],
    "name": "SeriesFrozen",
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
        "name": "settlementPrice",
        "type": "uint256"
      }
    ],
    "name": "SeriesSettled",
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
      }
    ],
    "name": "SeriesUnfrozen",
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
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "authorizedContracts",
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
        "name": "strikeE8",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "expiryTs",
        "type": "uint64"
      },
      {
        "internalType": "bool",
        "name": "isCall",
        "type": "bool"
      },
      {
        "internalType": "uint32",
        "name": "tickSizeE8",
        "type": "uint32"
      },
      {
        "internalType": "uint32",
        "name": "lotSize",
        "type": "uint32"
      },
      {
        "internalType": "uint256",
        "name": "initialIV",
        "type": "uint256"
      }
    ],
    "name": "createSeries",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
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
    "name": "freezeSeries",
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
    "name": "getSeries",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint64",
            "name": "strikeE8",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "expiryTs",
            "type": "uint64"
          },
          {
            "internalType": "bool",
            "name": "isCall",
            "type": "bool"
          },
          {
            "internalType": "uint32",
            "name": "tickSizeE8",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "lotSize",
            "type": "uint32"
          },
          {
            "internalType": "enum OptionMarketRegistry.Status",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "uint256",
            "name": "initialIV",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "settlementPrice",
            "type": "uint256"
          }
        ],
        "internalType": "struct OptionMarketRegistry.OptionSeries",
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
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "getStatus",
    "outputs": [
      {
        "internalType": "enum OptionMarketRegistry.Status",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
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
    "name": "isActive",
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
      }
    ],
    "name": "isSettled",
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
    "inputs": [],
    "name": "nextSeriesId",
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
    "name": "renounceOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "addr",
        "type": "address"
      },
      {
        "internalType": "bool",
        "name": "authorized",
        "type": "bool"
      }
    ],
    "name": "setAuthorizedContract",
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
      },
      {
        "internalType": "uint256",
        "name": "settlementPrice",
        "type": "uint256"
      }
    ],
    "name": "settleSeries",
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
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "unfreezeSeries",
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
