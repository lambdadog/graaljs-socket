import { EventEmitter } from 'events'

declare const Java

const J = {
  ByteBuffer: Java.type('java.nio.ByteBuffer'),
  Charset: Java.type('java.nio.charset.Charset'),
  InetSocketAddress: Java.type('java.net.InetSocketAddress'),
  ServerSocket: Java.type('java.nio.channels.AsynchronousServerSocketChannel'),
  Socket: Java.type('java.nio.channels.AsynchronousSocketChannel'),
  Throwable: Java.type('java.lang.Throwable'),
  TimeUnit: Java.type('java.util.concurrent.TimeUnit')
}

const utf8 = J.Charset.forName('utf-8')
const linefeed = utf8.encode("\n").rewind().get()

export type SocketServerOptions = {}

export class SocketServer extends EventEmitter {
  _serverSocket: typeof J.ServerSocket

  constructor(opts: SocketServerOptions, connectionListener?: (socket: Socket) => void) {
    super()

    if (typeof connectionListener !== 'undefined') {
      this.on('connection', connectionListener)
    }
  }

  bind(port: number, host?: string, callback?: () => void): void {
    if (typeof callback !== 'undefined') {
      this.on('listening', callback)
    }

    const completionHandler = {
      completed: ((jSocket: typeof Socket): void => {
        try {
          aspireTo(this._serverSocket.accept())
            .then(completionHandler.completed)
            .catch(completionHandler.failed)

          const socket = new Socket({
            javaSocket: jSocket
          })
          // set options?
          this.emit('connection', socket)
        } catch (err) {
          this.emit('error', err)
        }
      }).bind(this),

      failed: ((err: typeof J.Throwable): void => {
        this.emit('error', err)
      }).bind(this)
    }

    try {
      const socketAddress = typeof host !== 'undefined'
        ? new J.InetSocketAddress(host, port)
        : new J.InetSocketAddress(port)

      this._serverSocket = J.ServerSocket
        .open()
        .bind(socketAddress)

      aspireTo(this._serverSocket.accept())
        .then(completionHandler.completed)
        .catch(completionHandler.failed)
      this.emit('listening')
    } catch (err) {
      if (typeof callback !== 'undefined') {
        this.removeListener('listening', callback)
      }
      this.emit('error', err)
    }
  }

  // Fails with:
  // java.util.concurrent.ExecutionException: java.nio.channels.AsynchronousCloseException
  //
  // close(callback?: () => void): void {
  //   if (typeof callback !== 'undefined') {
  //     this.on('close', callback)
  //   }

  //   try {
  //     this._serverSocket.close()
  //     this.emit('close')
  //   } catch (err) {
  //     if (typeof callback !== 'undefined') {
  //       this.removeListener('close', callback)
  //     }
  //     this.emit('error', err)
  //   }
  }
}

export type SocketOptions = {
  javaSocket: typeof J.Socket | null
}

export class Socket extends EventEmitter {
  _socket: typeof J.Socket
  readBuffer: typeof J.ByteBuffer

  constructor(opts: SocketOptions) {
    super()

    this.readBuffer = J.ByteBuffer.allocate(8192)

    if (opts.javaSocket !== null) {
      this._socket = opts.javaSocket

      this.doRead()
    } else {
      // We're not really ready to deal with this being used as
      // a client yet...
      throw new Error("graaljs-socket can't be used as a client yet :(")
    }
  }

  write(data: string, callback?: () => void): void {
    if (typeof callback !== 'undefined') {
      this.once('drain', callback)
    }

    try {
      const completionHandler = {
        completed: ((bytes: number): void => {
          this.emit('drain')
        }).bind(this),

        failed: ((err: typeof J.Throwable): void => {
          this.emit('error', err)
        }).bind(this)
      }

      const buffer = utf8.encode(data)
      buffer.rewind()
      aspireTo(this._socket.write(buffer))
        .then(completionHandler.completed)
        .catch(completionHandler.failed)
    } catch (err) {
      this.emit('error', err)
    }
  }

  private doRead(): void {
    const completionHandler = {
      completed: ((bytes: number): void => {
        if (bytes === -1) {
          // End of stream
          this.emit('end')
          this.removeAllListeners()
          this._socket.close()
        } else { // It'd be nice to improve error handling in this block
          this.readBuffer.rewind()

          // FIXME: doesn't handle the case of bytes remaining in buffer correctly
          let outBytes = []
          for (let i=0;i<bytes;i++) {
            const byte = this.readBuffer.get()
            outBytes.push(byte)
            if (byte === linefeed) {
              this.readBuffer.compact()
              this.readBuffer.rewind()
              const msg = utf8.decode(J.ByteBuffer.wrap(outBytes)).toString()
              outBytes = []
              this.emit('data', msg)
            }
          }
          this.doRead()
        }
      }).bind(this),

      failed: ((err: typeof J.Throwable): void => {
        this.emit('error', err)
      }).bind(this)
    }
    aspireTo(this._socket.read(this.readBuffer))
      .then(completionHandler.completed)
      .catch(completionHandler.failed)
  }
}

// Can't type the future because typing Java interop is a mess
function aspireTo(future): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = setInterval(() => {
      try {
        const result = future.get(0, J.TimeUnit.NANOSECONDS)
        clearInterval(id)
        resolve(result)
      } catch (exc) {
        // typeof does not work for Java exceptions
        if (`${exc}` !== 'java.util.concurrent.TimeoutException') {
          clearInterval(id)
          reject(exc)
        }
      }
    }, 50)
  })
}
