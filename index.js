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

    const defaultConfig = (this.serverless.config.serverless.service.custom || {}).kong || {};
    const defaultLambdaConfig = (defaultConfig.lambda || {}).config || {};

    this.kong = new Kong({ adminAPIURL: defaultConfig.admin_api_url || 'http://localhost:8001' });

    // Create the dummy service for Lambda
    const service = await this.kong.services.createOrUpdate('lambda-dummy-service', {
      url: 'http://localhost:8001',
    });

    const functions = Object.keys(this.serverless.service.functions)
      .map(key => this.serverless.service.functions[key]);

    for (const f of functions) {
      const kongEvents = f.events.filter(e => e.kong !== undefined);

      for (const event of kongEvents) {
        const eventLambdaConfig = (event.kong.lambda || {}).config || {};
        const lambdaConfig = Object.assign(
          {},
          { aws_region: this.region, function_name: f.name },
          defaultLambdaConfig,
          eventLambdaConfig,
        );

        // create the route and add the aws-lambda plugin
        const route = await this.createRoute(service, event);
        await this.addLambdaPlugin(route, lambdaConfig);
        const plugins = event.kong.plugins || [];
        for (const plugin of plugins) {
          await this.addPluginToRoute(route, plugin);
        }
      }
    }
  }

  createRoute(service, event) {
    return this.kong.routes.create({
      service: { id: service.id },
      ...event.kong.route,
    });
  }

  addLambdaPlugin(route, config) {
    return this.kong.routes.addPlugin({
      routeId: route.id,
      name: 'aws-lambda',
      config,
      enabled: true,
    });
  }

  addPluginToRoute(route, plugin) {
    return this.kong.routes.addPlugin({
      routeId: route.id,
      ...plugin,
    });
  }
}

module.exports = ServerlessPlugin;
