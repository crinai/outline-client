// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {ChildProcess, execSync, spawn} from 'child_process';
import {powerMonitor} from 'electron';
import {platform} from 'os';

import * as errors from '../www/model/errors';

import {checkUdpForwardingEnabled, isServerReachable, validateServerCredentials} from './connectivity';
import {RoutingService} from './routing_service';
import {pathToEmbeddedBinary} from './util';

const isLinux = platform() === 'linux';
const isWindows = platform() === 'win32';

const PROXY_ADDRESS = '127.0.0.1';
const PROXY_PORT = 1081;

const TUN2SOCKS_TAP_DEVICE_NAME = isLinux ? 'outline-tun0' : 'outline-tap0';
const TUN2SOCKS_TAP_DEVICE_IP = '10.0.85.2';
const TUN2SOCKS_VIRTUAL_ROUTER_IP = '10.0.85.1';
const TUN2SOCKS_TAP_DEVICE_NETWORK = '10.0.85.0';
const TUN2SOCKS_VIRTUAL_ROUTER_NETMASK = '255.255.255.0';

// Coordinates routing and helper processes to establish a full-system VPN.
// Follows the Mediator pattern.
export class ConnectionMediator {
  private tun2socks = new Tun2socks(PROXY_ADDRESS, PROXY_PORT);

  // TODO: getter?
  public readonly onceStopped: Promise<void>;

  static newInstance(config: cordova.plugins.outline.ServerConfig, isAutoConnect: boolean):
      Promise<ConnectionMediator> {
    if (isWindows) {
      try {
        testTapDevice();
      } catch (e) {
        return Promise.reject(new errors.SystemConfigurationException(e.message));
      }
    }

    return new Promise((F, R) => {
      // test whether UDP is available; this determines the flags passed to tun2socks.
      // to perform this test, ss-local must be up and running.
      const ssLocal = new SsLocal(PROXY_PORT);
      ssLocal.setExitListener(() => {
        R(new Error('ss-local exited during UDP check'));
      });
      ssLocal.start(config);

      // ss-local should always start: wait a few seconds, with very fast retries and no timeout.
      isServerReachable(PROXY_ADDRESS, PROXY_PORT, undefined, 30)
          .then(() => {
            // Don't validate credentials on boot: if the key was revoked, we want the system to
            // stay "connected" so that traffic doesn't leak.
            if (isAutoConnect) {
              return;
            }
            return validateServerCredentials(PROXY_ADDRESS, PROXY_PORT);
          })
          .then(() => {
            return checkUdpForwardingEnabled(PROXY_ADDRESS, PROXY_PORT);
          })
          .then((udpEnabled) => {
            console.log(`UDP support: ${udpEnabled}`);
            return RoutingService.getInstanceAndStart(config.host || '', isAutoConnect)
                .then((routing) => {
                  F(new ConnectionMediator(routing, ssLocal, udpEnabled));
                });
          })
          .catch((e) => {
            ssLocal.stop();
            R(e);
          });
    });
  }

  private tun2socksExitListener?: () => void;

  private constructor(
      private readonly routing: RoutingService, private readonly ssLocal: SsLocal,
      private udpEnabled: boolean) {
    const exits = [
      this.routing.onceStopped.then(() => {
        console.log(`disconnected from routing service`);
      }),
      new Promise<void>((F) => {
        this.ssLocal.setExitListener(() => {
          console.log(`ss-local terminated`);
          F();
        });
      }),
      new Promise<void>((F) => {
        this.tun2socksExitListener = () => {
          console.log(`tun2socks terminated`);
          F();
        };
        this.tun2socks.setExitListener(this.tun2socksExitListener);
      })
    ];

    // if anything fails/exits, abandon ship.
    Promise.race(exits).then(this.stop.bind(this));

    // once they've *all* failed/exited, we're done.
    this.onceStopped = Promise.all(exits).then(() => {});

    // listen for network change events.
    this.routing.setNetworkChangeListener(this.networkChanged.bind(this));

    // tun2socks fails on suspend; we must listen for suspend/resume events and restart.
    const suspendListener = () => {
      powerMonitor.removeListener('suspend', suspendListener);

      // swap out the current listener, log.
      this.tun2socks.setExitListener(() => {
        console.log('stopped tun2socks in preparation for suspend');
      });

      powerMonitor.once('resume', () => {
        console.log('restarting tun2socks');
        checkUdpForwardingEnabled(PROXY_ADDRESS, PROXY_PORT)
            .then(
                (udpNowEnabled) => {
                  console.log(`UDP support: ${udpNowEnabled}`);
                  this.udpEnabled = udpNowEnabled;

                  // reinstate the "real" exit listener before (re-)starting.
                  this.tun2socks.setExitListener(this.tun2socksExitListener);
                  this.tun2socks.start(this.udpEnabled);

                  if (this.reconnectedListener) {
                    this.reconnectedListener();
                  }
                },
                (e) => {
                  // TODO: what can we do?
                  console.error(`could not test for UDP availability: ${e.message}`);
                });
      });
    };
    powerMonitor.on('suspend', suspendListener);

    // and go.
    this.tun2socks.start(udpEnabled);
  }

  private reconnectingListener?: () => void;
  setReconnectingListener(newListener?: () => void) {
    this.reconnectingListener = newListener;
  }

  private reconnectedListener?: () => void;
  setReconnectedListener(newListener?: () => void) {
    this.reconnectedListener = newListener;
  }

  private networkChanged(status: ConnectionStatus) {
    if (status === ConnectionStatus.CONNECTED) {
      // re-test for UDP availability and, if necessary, restart tun2socks.
      checkUdpForwardingEnabled(PROXY_ADDRESS, PROXY_PORT)
          .then(
              (udpNowEnabled) => {
                if (udpNowEnabled === this.udpEnabled) {
                  console.log('no change in UDP availability');
                  if (this.reconnectedListener) {
                    this.reconnectedListener();
                  }
                  return;
                }

                console.log(`UDP support change: ${this.udpEnabled} -> ${udpNowEnabled}`);
                this.udpEnabled = udpNowEnabled;

                // swap out the current listener, restart once the current process exits.
                this.tun2socks.setExitListener(() => {
                  console.log('terminated tun2socks for UDP change');

                  this.tun2socks.setExitListener(this.tun2socksExitListener);
                  this.tun2socks.start(this.udpEnabled);

                  if (this.reconnectedListener) {
                    this.reconnectedListener();
                  }
                });

                this.tun2socks.stop();
              },
              (e) => {
                // TODO: what can we do?
                console.error(`could not test for UDP availability: ${e.message}`);
              });
    } else if (status === ConnectionStatus.RECONNECTING) {
      // the routing service cannot currently connect (probably there's no
      // network connectivity).
      if (this.reconnectingListener) {
        this.reconnectingListener();
      }
    } else {
      console.error(`unknown network change status ${status} from routing service`);
    }
  }

  // returns immediately; use onceStopped for notifications.
  stop() {
    try {
      this.routing.stop();
    } catch (e) {
      // the service may have stopped while we were connected.
      console.error(`could not stop routing: ${e.message}`);
    }

    this.ssLocal.stop();
    this.tun2socks.stop();
  }
}

// Raises an error if:
//  - the TAP device does not exist
//  - the TAP device does not have the expected IP/subnet
//
// Note that this will *also* throw if netsh is not on the PATH. If that's the case then the
// installer should have failed, too.
function testTapDevice() {
  // Sample output:
  // =============
  // $ netsh interface ipv4 dump
  // # ----------------------------------
  // # IPv4 Configuration
  // # ----------------------------------
  // pushd interface ipv4
  //
  // reset
  // set global icmpredirects=disabled
  // set interface interface="Ethernet" forwarding=enabled advertise=enabled nud=enabled
  // ignoredefaultroutes=disabled set interface interface="outline-tap0" forwarding=enabled
  // advertise=enabled nud=enabled ignoredefaultroutes=disabled add address name="outline-tap0"
  // address=10.0.85.2 mask=255.255.255.0
  //
  // popd
  // # End of IPv4 configuration
  const lines = execSync(`netsh interface ipv4 dump`).toString().split('\n');

  // Find lines containing the TAP device name.
  const tapLines = lines.filter(s => s.indexOf(TUN2SOCKS_TAP_DEVICE_NAME) !== -1);
  if (tapLines.length < 1) {
    throw new Error(`TAP device not found`);
  }

  // Within those lines, search for the expected IP.
  if (tapLines.filter(s => s.indexOf(TUN2SOCKS_TAP_DEVICE_IP) !== -1).length < 1) {
    throw new Error(`TAP device has wrong IP`);
  }
}

class SingletonProcess {
  private process?: ChildProcess;

  constructor(private path: string) {}

  private exitListener?: () => void;

  setExitListener(newListener?: () => void): void {
    this.exitListener = newListener;
  }

  // Note that there is *no way* to tell whether a process was launched successfully: callers should
  // assume the process was launched successfully until they receive an exit message, which may
  // happen immediately after calling this function.
  protected startInternal(args: string[]) {
    if (this.process) {
      throw new Error('already running');
    }

    this.process = spawn(this.path, args);

    const onExit = () => {
      if (this.process) {
        this.process.removeAllListeners();
        this.process = undefined;
      }
      if (this.exitListener) {
        this.exitListener();
      }
    };

    // Listen for both: error is failure to launch, exit may not be invoked in that case.
    this.process.on('error', onExit.bind((this)));
    this.process.on('exit', onExit.bind((this)));
  }

  stop() {
    if (this.process) {
      this.process.kill();
    }
  }
}

class SsLocal extends SingletonProcess {
  constructor(private readonly proxyPort: number) {
    super(pathToEmbeddedBinary('shadowsocks-libev', 'ss-local'));
  }

  start(config: cordova.plugins.outline.ServerConfig) {
    // ss-local -s x.x.x.x -p 65336 -k mypassword -m aes-128-cfb -l 1081 -u
    const args = ['-l', this.proxyPort.toString()];
    args.push('-s', config.host || '');
    args.push('-p', '' + config.port);
    args.push('-k', config.password || '');
    args.push('-m', config.method || '');
    args.push('-t', '5');
    args.push('-u');

    this.startInternal(args);
  }
}

class Tun2socks extends SingletonProcess {
  constructor(private proxyAddress: string, private proxyPort: number) {
    super(pathToEmbeddedBinary('badvpn', 'badvpn-tun2socks'));
  }

  start(udpEnabled: boolean) {
    // ./badvpn-tun2socks.exe \
    //   --tundev "tap0901:outline-tap0:10.0.85.2:10.0.85.0:255.255.255.0" \
    //   --netif-ipaddr 10.0.85.1 --netif-netmask 255.255.255.0 \
    //   --socks-server-addr 127.0.0.1:1081 \
    //   --socks5-udp --udp-relay-addr 127.0.0.1:1081 \
    //   --transparent-dns
    const args: string[] = [];
    args.push(
        '--tundev',
        isLinux ? TUN2SOCKS_TAP_DEVICE_NAME :
                  `tap0901:${TUN2SOCKS_TAP_DEVICE_NAME}:${TUN2SOCKS_TAP_DEVICE_IP}:${
                      TUN2SOCKS_TAP_DEVICE_NETWORK}:${TUN2SOCKS_VIRTUAL_ROUTER_NETMASK}`);
    args.push('--netif-ipaddr', TUN2SOCKS_VIRTUAL_ROUTER_IP);
    args.push('--netif-netmask', TUN2SOCKS_VIRTUAL_ROUTER_NETMASK);
    args.push('--socks-server-addr', `${this.proxyAddress}:${this.proxyPort}`);
    args.push('--loglevel', 'error');
    args.push('--transparent-dns');
    if (udpEnabled) {
      args.push('--socks5-udp');
      args.push('--udp-relay-addr', `${this.proxyAddress}:${this.proxyPort}`);
    }

    this.startInternal(args);
  }
}
