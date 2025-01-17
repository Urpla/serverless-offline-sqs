const {join} = require('path');
const figures = require('figures');
const SQS = require('aws-sdk/clients/sqs');
const {mapValues, isEmpty, forEach, map, has, filter, get, pipe} = require('lodash/fp');
const {createHandler, getFunctionOptions} = require('serverless-offline/src/functionHelper');
let createLambdaContext;

try {
    createLambdaContext = require('serverless-offline/src/createLambdaContext');
} catch (e) {
    try {
        createLambdaContext = require('serverless-offline/src/LambdaContext');
    } catch (e2) {
        throw new error('Unable to fine lambda context file');
    }

}

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

const getConfig = (service, pluginName) => {
  return (service && service.custom && service.custom[pluginName]) || {};
};

const extractQueueNameFromARN = arn => {
  const [, , , , , QueueName] = arn.split(':');
  return QueueName;
};

class ServerlessOfflineSQS {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = getConfig(this.service, 'serverless-offline-sqs');

    this.commands = {};

    this.hooks = {
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getClient() {
    const awsConfig = Object.assign(
      {
        region: this.options.region || this.service.provider.region || 'us-west-2'
      },
      this.config
    );
    return new SQS(awsConfig);
  }

  getQueueName(queueEvent, functionName) {
    if (typeof queueEvent === 'string') return extractQueueNameFromARN(queueEvent);
    if (typeof queueEvent.arn === 'string') return extractQueueNameFromARN(queueEvent.arn);
    if (typeof queueEvent.queueName === 'string') return queueEvent.queueName;

    if (queueEvent.arn['Fn::GetAtt']) {
      const [ResourceName] = queueEvent.arn['Fn::GetAtt'];

      if (
        this.service &&
        this.service.resources &&
        this.service.resources.Resources &&
        this.service.resources.Resources[ResourceName] &&
        this.service.resources.Resources[ResourceName].Properties &&
        typeof this.service.resources.Resources[ResourceName].Properties.QueueName === 'string'
      )
        return this.service.resources.Resources[ResourceName].Properties.QueueName;
    }

    if(!!functionName) {
      return functionName;
    }

    throw new Error(
      `QueueName not found. See https://github.com/godu/serverless/tree/master/packages/serverless-offline-sqs#functions`
    );
  }

  eventHandler(queueEvent, functionName, messages, cb) {
    if (!messages) return cb();

    const streamName = this.getQueueName(queueEvent, functionName);
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);

    const {location = '.'} = getConfig(this.service, 'serverless-offline');

    const __function = this.service.getFunction(functionName);

    const {env} = process;
    const functionEnv = Object.assign(
      {},
      env,
      get('service.provider.environment', this),
      get('environment', __function)
    );
    process.env = functionEnv;

    const servicePath = join(this.serverless.config.servicePath, location);

    const funOptions = getFunctionOptions(__function, functionName, servicePath);
    const handler = createHandler(funOptions, {});

    const lambdaContext = createLambdaContext(__function, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${JSON.stringify(data) || ''}`
      );
      cb(err, data);
    });

    const event = {
      Records: messages.map(
        ({
          MessageId: messageId,
          ReceiptHandle: receiptHandle,
          Body: body,
          Attributes: attributes,
          MessageAttributes: messageAttributes,
          MD5OfBody: md5OfBody
        }) => ({
          messageId,
          receiptHandle,
          body,
          attributes,
          messageAttributes,
          md5OfBody,
          eventSource: 'aws:sqs',
          eventSourceARN: queueEvent.arn,
          awsRegion: 'us-west-2'
        })
      )
    };

    if (handler.length < 3)
      handler(event, lambdaContext)
        .then(res => lambdaContext.done(null, res))
        .catch(lambdaContext.done);
    else handler(event, lambdaContext, lambdaContext.done);

    process.env = env;
  }

  createQueueReadable(functionName, queueEvent) {
    const client = this.getClient();
    const queueName = this.getQueueName(queueEvent, functionName);

    this.serverless.cli.log(`${queueName}`);

    return fromCallback(cb =>
        client.getQueueUrl({ QueueName: queueName }, cb))
        .then((QueueUrlResponse) => {
            const QueueUrl = QueueUrlResponse.QueueUrl;
            const next = () => {
                return new Promise((resolve) => {
                    return fromCallback(cb =>
                        client.receiveMessage(
                          {
                            QueueUrl,
                            MaxNumberOfMessages: queueEvent.batchSize,
                            MessageAttributeNames: ['All'],
                            WaitTimeSeconds: 1
                          },
                          cb
                        )
                      ).then((MessagesResponse) => {
                          const Messages = MessagesResponse.Messages;
                        if (Messages) {
                            return fromCallback(cb => this.eventHandler(queueEvent, functionName, Messages, cb))
                            .then(() =>
                                fromCallback(cb2 =>
                                    client.deleteMessageBatch({
                                        Entries: (Messages || []).map(({MessageId: Id, ReceiptHandle}) => ({
                                                Id,
                                                ReceiptHandle
                                            })),
                                        QueueUrl
                                    },
                                    () => cb2()))
                            ).then(() => resolve(next()));
                          }

                          return resolve(next());
                      });
                })
            };

            return next();
        });
  }

  offlineStartInit() {
    this.serverless.cli.log(`Starting Offline SQS.`);

    mapValues.convert({cap: false})((_function, functionName) => {
      const queues = pipe(get('events'), filter(has('sqs')), map(get('sqs')))(_function);

      if (!isEmpty(queues)) {
        printBlankLine();
        this.serverless.cli.log(`SQS for ${functionName}:`);
      }

      forEach(queueEvent => {
        this.createQueueReadable(functionName, queueEvent);
      }, queues);

      if (!isEmpty(queues)) {
        printBlankLine();
      }
    }, this.service.functions);
  }

  offlineStartEnd() {
    this.serverless.cli.log('offline-start-end');
  }
}

module.exports = ServerlessOfflineSQS;
