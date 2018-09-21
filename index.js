const Kong = require('@tropos/kong-admin-api-client');

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.kong = null;

    this.hooks = {
      'after:deploy:deploy': this.afterDeployFunctions.bind(this),
    };
  }

  /**
   * @description hook to after deployment
   *
   * @return {Promise}
   */

  async afterDeployFunctions() {
    this.stage = this.serverless.service.provider.stage || 'dev';
    this.region = this.serverless.service.provider.region || 'us-east-1';
    this.providerName = this.serverless.service.provider.name;

    const config = (this.serverless.config.serverless.service.custom || {}).kong || {}

    this.kong = new Kong({ adminAPIURL: config.admin_api_url || 'http://localhost:8001' });

    // Create the dummy service for Lambda
    const service = await this.kong.services.createOrUpdate('lambda-dummy-service', {
      url: 'http://localhost:8001',
    });

    // create the routes in Kong for each function with a Kong event
    for (const f of Object.keys(this.serverless.service.functions)) {
      const func = this.serverless.service.functions[f];
      const kongEvents = func.events.filter(e => e.kong !== undefined);
      for (const event of kongEvents) {
        const route = await this.createRoute(service, event);
        await this.createPlugin(route, event, config);
      }
    }
  }

  createRoute(service, event) {
    return this.kong.routes.create({
      service: { id: service.id },
      paths: event.kong.paths,
      methods: event.kong.methods,
      hosts: event.kong.hosts,
      protocols: event.kong.protocols,
    });
  }

  createPlugin(route, event, config) {
    return this.kong.routes.addPlugin({
      routeId: route.id,
      name: 'aws-lambda',
      config: {
        aws_key: event.kong.aws_key || config.aws_key,
        aws_secret: event.kong.aws_secret || config.aws_secret,
        aws_region: event.kong.region || config.region || this.region,
        function_name: func.name,
      },
      enabled: true,
    });
  }
}

module.exports = ServerlessPlugin;
