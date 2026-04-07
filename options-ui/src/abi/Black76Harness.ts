export const Black76HarnessAbi = [
  {
    "inputs": [],
    "name": "ExpOverflow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "IVSolverPremiumBelowIntrinsic",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInputs",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LnNegativeUndefined",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Overflow",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "F",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "K",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "sigma",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "tSec",
        "type": "uint256"
      }
    ],
    "name": "callPrice",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "F",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "K",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "sigma",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "tSec",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "isCall",
        "type": "bool"
      }
    ],
    "name": "greeks",
    "outputs": [
      {
        "internalType": "int256",
        "name": "delta",
        "type": "int256"
      },
      {
        "internalType": "uint256",
        "name": "gamma",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "vega",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "F",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "K",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "tSec",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "targetPremium",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "isCall",
        "type": "bool"
      }
    ],
    "name": "impliedVol",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "F",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "K",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "sigma",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "tSec",
        "type": "uint256"
      }
    ],
    "name": "pricesAndDelta",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "call",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "put",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "cDelta",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "F",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "K",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "sigma",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "tSec",
        "type": "uint256"
      }
    ],
    "name": "putPrice",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  }
] as const;
