/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import {
  Annotations,
  Stack,
} from 'aws-cdk-lib';
import {
  CfnDBCluster,
  CfnDBInstance,
  DatabaseCluster,
  IDatabaseCluster,
} from 'aws-cdk-lib/aws-docdb';
import {
  IConnectable,
  ISecurityGroup,
  OperatingSystemType,
  Port,
  Volume,
} from 'aws-cdk-lib/aws-ec2';
import {
  IGrantable,
} from 'aws-cdk-lib/aws-iam';
import {
  ISecret,
} from 'aws-cdk-lib/aws-secretsmanager';
import { Construct, IConstruct } from 'constructs';

import {
  IMongoDb,
  IX509CertificatePkcs12,
  MongoDbInstance,
  ScriptAsset,
} from '../../core';
import {
  IHost,
} from './host-ref';

/**
 * Options when constructing UserData for Linux
 */
export interface DocDBConnectionOptions {

  /**
   * The Document DB Cluster this connection is for.
   * Note: Deadline officially supports only databases that are compatible with MongoDB 5.0 and greater.
   */
  readonly database: IDatabaseCluster;

  /**
   * A Secret that contains the login information for the database. This must be a secret containing a JSON document as follows:
   *     {
   *         "username": "<username>",
   *         "password": "<password for username>"
   *     }
   */
  readonly login: ISecret;
}

export interface MongoDbInstanceConnectionOptions {
  /**
   * The MongoDB database to connect to.
   * Note: Deadline officially supports only databases that are compatible with MongoDB 5.0 and higher.
   */
  readonly database: IMongoDb;

  /**
   * The client certificate to register in the database during install of the Deadline Repository,
   * and for the Deadline Client to use to connect to the database.
   *
   * This **MUST** be signed by the same signing certificate as the MongoDB server's certificate.
   *
   * Note: A limitation of Deadline **requires** that this certificate be signed directly by your root certificate authority (CA).
   * Deadline will be unable to connect to MongoDB if it has been signed by an intermediate CA.
   */
  readonly clientCertificate: IX509CertificatePkcs12;
}

/**
 * Helper class for connecting Thinkbox's Deadline to a specific Database.
 */
export abstract class DatabaseConnection {
  /**
   * Creates a DatabaseConnection which allows Deadline to connect to Amazon DocumentDB.
   * Note: Deadline officially supports only databases that are compatible with MongoDB 5.0 and higher.
   *
   * Resources Deployed
   * ------------------------
   * This construct does not deploy any resources
   */
  public static forDocDB(options: DocDBConnectionOptions): DatabaseConnection {
    return new DocDBDatabaseConnection(options);
  }

  /**
   * Creates a DatabaseConnection which allows Deadline to connect to MongoDB.
   * Note: Deadline officially supports only databases that are compatible with MongoDB 5.0 and higher.
   *
   * Resources Deployed
   * ------------------------
   * This construct does not deploy any resources
   */
  public static forMongoDbInstance(options: MongoDbInstanceConnectionOptions): DatabaseConnection {
    return new MongoDbInstanceDatabaseConnection(options);
  }

  /**
   * Returns the environment variables for configuring containers to connect to the database
   */
  public abstract readonly containerEnvironment: { [name: string]: string };

  /**
   * Holds the CDK Construct that contains the database, or undefined if the database was imported into this application.
   */
  public abstract readonly databaseConstruct?: Construct;

  /**
   * Allow connections to the Database from the given connection peer
   */
  public abstract allowConnectionsFrom(other: IConnectable): void;

  /**
   * Adds commands to a UserData to build the argument list needed to install the Deadline Repository.
   *
   * The implementation must export a shell function called configure_database_installation_args(),
   * that takes no arguments. This function must define an array environment variable called
   * INSTALLER_DB_ARGS where each element of the array is a key-value pair of Deadline installer
   * option to option value. (ex: ["--dbuser"]=someusername).
   *
   * This implementation avoids secrets being leaked to the cloud-init logs.
   */
  public abstract addInstallerDBArgs(host: IHost): void;

  /**
   * Adds commands to an Instance or Autoscaling groups User Data to configure the Deadline client so it can access the DB
   *
   * Implementation must add commands to the instance userData that exports a function
   * called configure_deadline_database() that accepts no arguments, and does what ever
   * deadline-specific setup is required to allow Deadline to connect to the database.
   *
   * This implementation avoids secrets being leaked to the cloud-init logs.
   * @param host
   */
  public abstract addConnectionDBArgs(host: IHost): void;

  /**
   * Grants permissions to the principal that allow it to use the Database as a typical Deadline user.
   */
  public abstract grantRead(grantee: IGrantable): void;

  /**
   * Add an ordering dependency to another Construct.
   *
   * All constructs in the child's scope will be deployed after the database has been deployed.
   *
   * This can be used to ensure that the database is fully up and serving data before an instance attempts to connect to it.
   *
   * @param child The child to make dependent upon this database.
   */
  public abstract addChildDependency(child: IConstruct): void;

  /**
   * Adds a security group to the database.
   *
   * @param securityGroups The security group to add.
   */
  public abstract addSecurityGroup(...securityGroups: ISecurityGroup[]): void;
}

/**
 * Specialization of {@link DatabaseConnection} targetting Amazon DocumentDB.
 */
class DocDBDatabaseConnection extends DatabaseConnection {
  /**
   * @inheritdoc
   */
  public readonly containerEnvironment: { [name: string]: string };

  /**
   * @inheritdoc
   */
  public readonly databaseConstruct?: Construct;

  constructor(private readonly props: DocDBConnectionOptions) {
    super();

    if (!this.isCompatibleDocDBVersion()) {
      Annotations.of(props.database).addError('engineVersion must be one of 3.6.0, 4.0.0 or 5.0.0 to be compatible with Deadline');
    }

    this.containerEnvironment = {
      // The container must fetch the credentials from Secrets Manager
      DB_CREDENTIALS_URI: this.props.login.secretArn,
    };

    if (props.database instanceof DatabaseCluster) {
      this.databaseConstruct = props.database;
    }
  }

  /**
   * @inheritdoc
   */
  public addInstallerDBArgs(host: IHost): void {
    if (host.osType !== OperatingSystemType.LINUX) {
      throw new Error('Can only install Deadline from a Linux instance.');
    }
    host.userData.addCommands(
      'configure_database_installation_args(){',
      'getJsonVal(){ python3 -c \'import json,sys;obj=json.load(sys.stdin);print(obj["\'$1\'"])\'; }',
      'SET_X_IS_SET=$-',
      '{ set +x; } 2>/dev/null',
      `export SECRET_STRING=\`aws secretsmanager get-secret-value --secret-id ${this.props.login.secretArn} --region ${Stack.of(this.props.login).region} | getJsonVal 'SecretString'\``,
      "DB_USERNAME=`printenv SECRET_STRING | getJsonVal 'username'`",
      "DB_PASSWORD=`printenv SECRET_STRING | getJsonVal 'password'`",
      'unset SECRET_STRING',
      `INSTALLER_DB_ARGS=( ["--dbuser"]=$DB_USERNAME ["--dbpassword"]=$DB_PASSWORD ["--dbhost"]=${this.props.database.clusterEndpoint.hostname}` +
      ` ["--dbport"]=${this.props.database.clusterEndpoint.portAsString()} ["--dbtype"]=DocumentDB )`,
      'unset DB_USERNAME',
      'unset DB_PASSWORD',
      'if [[ $SET_X_IS_SET =~ x ]]; then set -x; else set +x; fi',
      '}',
      'export -f configure_database_installation_args',
    );
  }

  /**
   * @inheritdoc
   */
  public addConnectionDBArgs(host: IHost): void {
    if (host.osType !== OperatingSystemType.LINUX) {
      throw new Error('Connecting to the Deadline Database is currently only supported for Linux.');
    }
    host.userData.addCommands(
      'configure_deadline_database(){',
      'getJsonVal(){ python3 -c \'import json,sys;obj=json.load(sys.stdin);print(obj["\'$1\'"])\'; }',
      'SET_X_IS_SET=$-',
      '{ set +x; } 2>/dev/null',
      `export SECRET_STRING=\`aws secretsmanager get-secret-value --secret-id ${this.props.login.secretArn} --region ${Stack.of(this.props.login).region} | getJsonVal 'SecretString'\``,
      "DB_USERNAME=`printenv SECRET_STRING | getJsonVal 'username'`",
      "DB_PASSWORD=`printenv SECRET_STRING | getJsonVal 'password'`",
      'unset SECRET_STRING',
      'sudo -u ec2-user "${deadlinecommand}" -StoreDatabasecredentials "${DB_USERNAME}" "${DB_PASSWORD}"',
      'unset DB_USERNAME',
      'unset DB_PASSWORD',
      'if [[ $SET_X_IS_SET =~ x ]]; then set -x; else set +x; fi',
      '}',
      'export -f configure_deadline_database',
    );
  }

  /**
   * @inheritdoc
   */
  public allowConnectionsFrom(other: IConnectable) {
    other.connections.allowTo(this.props.database, this.props.database.connections.defaultPort!);
  }

  /**
   * @inheritdoc
   */
  public grantRead(grantee: IGrantable): void {
    this.props.login.grantRead(grantee);
  }

  /**
   * @inheritdoc
   */
  public addChildDependency(child: IConstruct): void {
    // To depend on document DB it is not sufficient to depend on the Cluster. The instances are what serves data, so
    // we must add a dependency to an instance in the DocDB cluster.

    // The DocDB L2 does not expose any of its instances as properties, so we have to escape-hatch to gain access.
    const docdbInstance = this.props.database.node.tryFindChild('Instance1') as CfnDBInstance;

    // We won't find an instance in two situations:
    //  1) The DocDB Cluster was created from attributes. In this case, the DocDB pre-exists the stack and there's no need
    //     to depend on anything.
    //  2) The DocDB Cluster was constructed, but the internal name for the instance has been changed from 'Instance1'; this is
    //     unlikely, but not impossible.
    // We can differentiate cases (1) & (2) by looking for the defaultChild on the cluster. The version from attributes will not have one.
    if (docdbInstance) {
      child.node.addDependency(docdbInstance);
    } else if (this.props.database.node.defaultChild) {
      throw new Error('The internal implementation of the AWS CDK\'s DocumentDB cluster construct may have changed. Please update to a newer RFDK for an updated implementation, or file a ticket if this is the latest release.');
    }
  }

  /**
   * @inheritdoc
   */
  public addSecurityGroup(...securityGroups: ISecurityGroup[]): void {
    let added = false;
    const errorReasons: string[] = [];
    if (this.props.database instanceof DatabaseCluster) {
      const resource = (this.props.database as DatabaseCluster).node.tryFindChild('Resource');

      // TODO: Replace this code with the addSecurityGroup method of DatabaseCluster once this PR is merged:
      // https://github.com/aws/aws-cdk/pull/13290
      if (resource instanceof CfnDBCluster) {
        const cfnCluster = resource as CfnDBCluster;
        const securityGroupIds = securityGroups.map(sg => sg.securityGroupId);

        if (cfnCluster.vpcSecurityGroupIds === undefined) {
          cfnCluster.vpcSecurityGroupIds = securityGroupIds;
        } else {
          cfnCluster.vpcSecurityGroupIds.push(...securityGroupIds);
        }
        added = true;
      } else {
        errorReasons.push('The internal implementation of AWS CDK\'s DocumentDB cluster construct has changed.');
      }
    } else {
      errorReasons.push('The "database" property passed to this class is not an instance of AWS CDK\'s DocumentDB cluster construct.');
    }

    if (!added) {
      Annotations.of(this.props.database).addWarning(
        `Failed to add the following security groups to ${this.props.database.node.id}: ${securityGroups.map(sg => sg.node.id).join(', ')}. ` +
        errorReasons.join(' '),
      );
    }
  }

  /**
   * Deadline is compatible with MongoDB 5.0 and greater. This function attempts to determine whether
   * the given DocDB version is compatible.
   */
  protected isCompatibleDocDBVersion(): boolean {
    // The defaultChild of a DocDB DatabaseCluster is a CfnDBCluster, but we only have this
    // child if the customer didn't import from attributes. We can check the DB version by
    // checking the value of the engineVersion property of that object.
    if (this.props.database.node.defaultChild) {
      const cluster = this.props.database.node.defaultChild! as CfnDBCluster;
      return ( cluster.engineVersion?.startsWith('3.6') || cluster.engineVersion?.startsWith('4.0') || cluster.engineVersion?.startsWith('5.0') )?? false;
    }

    return true; // No information, assume it's compatible.
  }
}

/**
 * Specialization of {@link DatabaseConnection} targetting MongoDB.
 */
class MongoDbInstanceDatabaseConnection extends DatabaseConnection {
  private static readonly DB_CERT_LOCATION: string = '/opt/Thinkbox/certs/mongo_client.pfx';

  /**
   * @inheritdoc
   */
  public readonly containerEnvironment: { [name: string]: string };

  /**
   * @inheritdoc
   */
  public readonly databaseConstruct?: Construct;

  constructor(protected readonly props: MongoDbInstanceConnectionOptions) {
    super();
    this.containerEnvironment = {
      DB_TLS_CLIENT_CERT_URI: props.clientCertificate.cert.secretArn,
      DB_TLS_CLIENT_CERT_PASSWORD_URI: props.clientCertificate.passphrase.secretArn,
    };

    if (props.database instanceof MongoDbInstance) {
      if (props.database.mongoDataVolume instanceof Volume) {
        this.databaseConstruct = props.database.mongoDataVolume;
      }
    }
  }

  /**
   * @inheritdoc
   */
  public allowConnectionsFrom(other: IConnectable) {
    other.connections.allowTo(this.props.database, Port.tcp(this.props.database.port));
  }

  /**
   * @inheritdoc
   */
  public addInstallerDBArgs(host: IHost): void {
    if (host.osType !== OperatingSystemType.LINUX) {
      throw new Error('Can only install Deadline from a Linux instance.');
    }
    this.downloadCertificate(host);
    const certPwSecret = this.props.clientCertificate.passphrase;
    host.userData.addCommands(
      'configure_database_installation_args(){',
      'getJsonVal(){ python3 -c \'import json,sys;obj=json.load(sys.stdin);print(obj["\'$1\'"])\'; }',
      // Suppress -x, so no secrets go to the logs
      'SET_X_IS_SET=$-',
      '{ set +x; } 2>/dev/null',
      `CERT_PASSWORD=$(aws secretsmanager get-secret-value --secret-id ${certPwSecret.secretArn} --region ${Stack.of(certPwSecret).region} | getJsonVal 'SecretString')`,
      'INSTALLER_DB_ARGS=( ["--dbssl"]=true ["--dbauth"]=true ["--dbsslauth"]=true ' +
      `["--dbhost"]="${this.props.database.fullHostname}" ["--dbport"]=${this.props.database.port} ` +
      `["--dbclientcert"]="${MongoDbInstanceDatabaseConnection.DB_CERT_LOCATION}" ["--dbcertpass"]=$CERT_PASSWORD )`,
      'unset CERT_PASSWORD',
      // Restore -x, if it was set.
      'if [[ $SET_X_IS_SET =~ x ]]; then set -x; else set +x; fi',
      '}',
      'export -f configure_database_installation_args',
    );
  }

  /**
   * @inheritdoc
   */
  public addConnectionDBArgs(host: IHost): void {
    if (host.osType !== OperatingSystemType.LINUX) {
      throw new Error('Connecting to the Deadline Database is currently only supported for Linux.');
    }
    this.downloadCertificate(host);
    const certPwSecret = this.props.clientCertificate.passphrase;
    host.userData.addCommands(
      'configure_deadline_database(){',
      'getJsonVal(){ python3 -c \'import json,sys;obj=json.load(sys.stdin);print(obj["\'$1\'"])\'; }',
      'SET_X_IS_SET=$-',
      '{ set +x; } 2>/dev/null',
      `export DB_CERT_FILE="${MongoDbInstanceDatabaseConnection.DB_CERT_LOCATION}"`,
      `export DB_CERT_PASSWORD=$(aws secretsmanager get-secret-value --secret-id ${certPwSecret.secretArn} --region ${Stack.of(certPwSecret).region} | getJsonVal 'SecretString')`,
      'if [[ $SET_X_IS_SET =~ x ]]; then set -x; else set +x; fi',
      '}',
      'export -f configure_deadline_database',
    );

  }

  /**
   * @inheritdoc
   */
  public grantRead(grantee: IGrantable): void {
    this.props.clientCertificate.cert.grantRead(grantee);
    this.props.clientCertificate.passphrase.grantRead(grantee);
  }

  /**
   * @inheritdoc
   */
  public addChildDependency(child: IConstruct): void {
    if (this.props.database.hasOwnProperty('server')) {
      const db = this.props.database as MongoDbInstance;
      child.node.addDependency(db.server.autoscalingGroup.node.defaultChild!);
    }
  }

  /**
   * @inheritdoc
   */
  public addSecurityGroup(...securityGroups: ISecurityGroup[]): void {
    this.props.database.addSecurityGroup(...securityGroups);
  }

  /**
   * Download the client PKCS#12 certificate for authenticating to the MongoDB, and place it into
   * the path defined by: DB_CERT_LOCATION
   * @param host
   */
  private downloadCertificate(host: IHost): void {
    const stack = Stack.of(host);
    const uuid = 'e8125dd2-ab2c-4861-8ee4-998c26b30ee0';
    const uniqueId = 'GetSecretToFile' + host.osType + uuid.replace(/[-]/g, '');
    const getSecretsScript =
          stack.node.tryFindChild(uniqueId) as unknown as ScriptAsset ??
            ScriptAsset.fromPathConvention(stack, uniqueId, {
              osType: host.osType,
              baseName: 'getSecretToFile',
              rootDir: path.join(__dirname, '..', 'scripts'),
            });
    getSecretsScript.executeOn({
      host,
      args: [
        this.props.clientCertificate.cert.secretArn,
        MongoDbInstanceDatabaseConnection.DB_CERT_LOCATION,
      ],
    });
  }
}
